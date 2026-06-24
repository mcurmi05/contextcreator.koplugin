#per-source cover storage + resolution. every connecting device contributes the cover it extracted, and
#the user can upload a "custom" one; the displayed cover (cached on Book.cover / LibraryEntry.cover for
#cheap reads) is resolved from these by the user's choice, defaulting to the freshest source. this is what
#lets a user pick which device's cover (grayscale e-ink vs colour screen) — or their own — to show.
from sqlmodel import select

from . import docops
from ..models import Book, BookCover, CoverChoice, LibraryEntry

CUSTOM = "custom"           #legacy single custom-cover source
CUSTOM_PREFIX = "custom-"    #user uploads get a unique source id under this prefix (many are allowed)


def is_custom(source):
    return source == CUSTOM or (isinstance(source, str) and source.startswith(CUSTOM_PREFIX))


def _covers(session, user_id, book_id):
    return session.exec(select(BookCover).where(
        BookCover.user_id == user_id, BookCover.book_id == book_id)).all()


def _one(session, user_id, book_id, source):
    return session.exec(select(BookCover).where(
        BookCover.user_id == user_id, BookCover.book_id == book_id, BookCover.source == source)).first()


def _choice(session, user_id, book_id):
    return session.exec(select(CoverChoice).where(
        CoverChoice.user_id == user_id, CoverChoice.book_id == book_id)).first()


def record_cover(session, user_id, book_id, source, cover, *, label=""):
    #upsert one source's cover for a book (a device's extraction, or a custom upload)
    if not source or not cover:
        return
    row = _one(session, user_id, book_id, source)
    if row:
        row.cover = cover
        row.updated = docops.now()
        if label:
            row.label = label
    else:
        session.add(BookCover(user_id=user_id, book_id=book_id, source=source,
                              label=label, cover=cover, updated=docops.now()))


def set_choice(session, user_id, book_id, source):
    #pin which source to show ("" = automatic / freshest)
    row = _choice(session, user_id, book_id)
    if row:
        row.source = source or ""
    else:
        session.add(CoverChoice(user_id=user_id, book_id=book_id, source=source or ""))


def remove_source(session, user_id, book_id, source):
    #drop one source's cover (e.g. a custom upload); fall back to automatic if it was the chosen one
    row = _one(session, user_id, book_id, source)
    if row:
        session.delete(row)
    ch = _choice(session, user_id, book_id)
    if ch and ch.source == source:
        ch.source = ""


def _effective(session, user_id, book_id):
    rows = _covers(session, user_id, book_id)
    if not rows:
        return None
    ch = _choice(session, user_id, book_id)
    if ch and ch.source:
        pick = next((r for r in rows if r.source == ch.source), None)
        if pick:
            return pick
    return min(rows, key=lambda r: r.id or 0)  #default: the cover that was first synced (lowest row id)


def resolve(session, user_id, book_id):
    #recompute the shown cover from the chosen/freshest source and cache it on Book + LibraryEntry, so all
    #the read paths (/api/books, /api/library, the composed doc) keep reading a single `cover` field.
    session.flush()  #make any just-added BookCover / LibraryEntry rows visible to the queries below
    pick = _effective(session, user_id, book_id)
    if pick is None:
        #no per-source covers yet (e.g. an existing book before devices re-sync, or an imported file) —
        #leave whatever cover is already displayed untouched rather than wiping it to blank.
        return None
    book = session.exec(select(Book).where(Book.user_id == user_id, Book.book_id == book_id)).first()
    if book is not None:
        book.cover = pick.cover
    le = session.exec(select(LibraryEntry).where(
        LibraryEntry.user_id == user_id, LibraryEntry.book_id == book_id)).first()
    if le is not None:
        le.cover = pick.cover
    return pick.cover


def book_ids_with_source(session, user_id, source):
    #set of book_ids this source has already provided a cover for (so sync can ask only for missing ones)
    return set(session.exec(select(BookCover.book_id).where(
        BookCover.user_id == user_id, BookCover.source == source)).all())


def account_devices(session, user_id):
    #the distinct device cover-sources across the whole account (not custom uploads, not imported files),
    #so the settings page can offer "set every book to this device's covers". label = first one seen.
    seen = {}
    for source, label in session.exec(select(BookCover.source, BookCover.label).where(BookCover.user_id == user_id)).all():
        if is_custom(source) or source == "imported":
            continue
        seen.setdefault(source, label or source)
    return [{"source": s, "label": lbl} for s, lbl in seen.items()]


def overview(session, user_id):
    #account-wide cover picture for the settings panel: the device sources, plus every book that has any
    #cover with its available sources + which one is shown. labels only (no image bytes) so it stays light.
    rows_by_book = {}
    for r in session.exec(select(BookCover).where(BookCover.user_id == user_id)).all():
        rows_by_book.setdefault(r.book_id, []).append(r)
    titles = {}
    for b in session.exec(select(Book.book_id, Book.title).where(Book.user_id == user_id)).all():
        titles[b[0]] = b[1] or b[0]
    for le in session.exec(select(LibraryEntry.book_id, LibraryEntry.title).where(LibraryEntry.user_id == user_id)).all():
        titles.setdefault(le[0], le[1] or le[0])
    books = []
    for book_id, rows in rows_by_book.items():
        #the settings panel manages device covers only (custom uploads are handled on the home page picker)
        device_rows = sorted([r for r in rows if not is_custom(r.source)], key=lambda r: r.id or 0)
        if not device_rows:
            continue
        pick = _effective(session, user_id, book_id)
        books.append({
            "book_id": book_id, "title": titles.get(book_id, book_id),
            "current": pick.source if pick else None,
            "sources": [{"source": r.source, "label": r.label or r.source} for r in device_rows],
        })
    books.sort(key=lambda b: (b["title"] or "").lower())
    return {"devices": account_devices(session, user_id), "books": books}


def set_all_to_source(session, user_id, source):
    #point every book that has a cover from `source` at it (the others are left as they are). returns count.
    return set_many_to_source(session, user_id, source, book_ids_with_source(session, user_id, source))


def set_many_to_source(session, user_id, source, book_ids):
    #point the given books at `source` (skipping any that don't have a cover from it). returns count set.
    have = book_ids_with_source(session, user_id, source)
    n = 0
    for bid in book_ids:
        if bid in have:
            set_choice(session, user_id, bid, source)
            resolve(session, user_id, bid)
            n += 1
    return n


def list_for_book(session, user_id, book_id):
    #the cover options + which is shown, for the web picker. device covers first (oldest = first synced
    #leads), then custom uploads. `current` is the source actually shown (the chosen one, else first synced).
    rows = sorted(_covers(session, user_id, book_id), key=lambda r: (is_custom(r.source), r.id or 0))
    pick = _effective(session, user_id, book_id)
    return {
        "covers": [{"source": r.source, "label": r.label or r.source, "cover": r.cover,
                    "custom": is_custom(r.source)} for r in rows],
        "current": pick.source if pick else None,
    }
