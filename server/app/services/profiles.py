#profiles let one book hold several named context documents. this module is the single place that knows
#how a stored Book (book meta + shared reading position/toc) and a Profile (the notes) combine into the
#full doc clients see, and how a doc coming back in splits between the two. the additive merge in sync.py
#is reused wholesale; we just route book-level fields to the Book and note-level fields to the Profile.
import json
import secrets

from sqlmodel import select

from . import covers, devices, docops
from ..models import Book, DevicePosition, LibraryEntry, Profile, ProfileTombstone
from .sync import _normalize, merge, new_doc

DEFAULT_PID = "default"


def _tomb(session, user_id, book_id, profile_id):
    return session.exec(select(ProfileTombstone).where(
        ProfileTombstone.user_id == user_id, ProfileTombstone.book_id == book_id,
        ProfileTombstone.profile_id == profile_id)).first()


def tombstone_profile(session, user_id, book_id, profile_id, version):
    #mark a profile as deleted, remembering the content version (`updated`) it had, so a later device push
    #with strictly newer real content can still resurrect it but a stale/empty replay can't.
    row = _tomb(session, user_id, book_id, profile_id)
    if row:
        row.version = max(row.version or 0, version or 0)
    else:
        session.add(ProfileTombstone(user_id=user_id, book_id=book_id, profile_id=profile_id, version=version or 0))


def profile_tombstone_version(session, user_id, book_id, profile_id):
    row = _tomb(session, user_id, book_id, profile_id)
    return row.version if row else None


def clear_profile_tombstone(session, user_id, book_id, profile_id):
    row = _tomb(session, user_id, book_id, profile_id)
    if row:
        session.delete(row)


def _without_cover(doc):
    #the cover is a big data: url and is book-level; compose() re-overlays it from the Book on read, so we
    #keep it out of the per-profile notes blob we persist (avoids bloating every profile's doc_json).
    meta = doc.get("book")
    if isinstance(meta, dict) and meta.get("cover"):
        return {**doc, "book": {k: v for k, v in meta.items() if k != "cover"}}
    return doc


def record_device_position(session, user_id, book_id, device_id, reading_progress, *,
                           device_name=None, chapter=None, chapter_frac=None):
    #remember where one device has read up to, so the web can offer a per-device "jump to current".
    #upsert by (user, book, device); ignored when there's no usable position or no device id. the chapter
    #(+ fraction through it) is what lets the web re-anchor this device onto a shared cross-device timeline.
    if not device_id or not isinstance(reading_progress, (int, float)) or isinstance(reading_progress, bool):
        return
    rp = max(0.0, min(1.0, float(reading_progress)))
    row = session.exec(
        select(DevicePosition).where(
            DevicePosition.user_id == user_id, DevicePosition.book_id == book_id,
            DevicePosition.device_id == device_id,
        )
    ).first()
    if row is None:
        row = DevicePosition(user_id=user_id, book_id=book_id, device_id=device_id)
        session.add(row)
    row.reading_progress = rp
    row.updated = docops.now()
    #a user-set device name overrides the reported one, so a rename sticks across syncs
    row.device_name = devices.resolve_name(session, user_id, device_id, (device_name or "").strip())
    #chapter is sent on every sync; treat empty as "unknown" but always refresh frac alongside it
    if chapter is not None:
        row.chapter = chapter.strip()
        row.chapter_frac = (max(0.0, min(1.0, float(chapter_frac)))
                            if isinstance(chapter_frac, (int, float)) and not isinstance(chapter_frac, bool)
                            else None)


def list_device_positions(session, user_id, book_id):
    #every device's last-read spot for a book, freshest first (so the most recently active device leads)
    return session.exec(
        select(DevicePosition).where(
            DevicePosition.user_id == user_id, DevicePosition.book_id == book_id,
        ).order_by(DevicePosition.updated.desc())
    ).all()


def _book(session, user_id, book_id):
    return session.exec(select(Book).where(Book.user_id == user_id, Book.book_id == book_id)).first()


def list_profiles(session, user_id, book_id):
    #all of a book's profiles, oldest first (so "Main" leads)
    return session.exec(
        select(Profile).where(Profile.user_id == user_id, Profile.book_id == book_id).order_by(Profile.created)
    ).all()


def get_profile(session, user_id, book_id, profile_id):
    return session.exec(
        select(Profile).where(
            Profile.user_id == user_id, Profile.book_id == book_id, Profile.profile_id == profile_id
        )
    ).first()


def gen_profile_id():
    return "p-" + secrets.token_hex(6)


def find_external_by_origin(session, user_id, origin_id):
    #the existing web-only "Imported" book that came from the same underlying book, if any, so further
    #imports/copies of that book join it as new profiles instead of spawning separate entries
    if not origin_id:
        return None
    return session.exec(
        select(Book).where(Book.user_id == user_id, Book.source == "external", Book.origin_id == origin_id)
    ).first()


def unique_profile_name(session, user_id, book_id, name):
    #keep profile names distinct within a book (append " (2)", " (3)"… on a clash)
    name = (name or "Profile").strip() or "Profile"
    taken = {p.name for p in list_profiles(session, user_id, book_id)}
    if name not in taken:
        return name
    n = 2
    while f"{name} ({n})" in taken:
        n += 1
    return f"{name} ({n})"


def add_external_profile(session, user_id, book, doc, *, name):
    #store `doc` as a new profile on an existing external book, return the profile_id
    doc = _normalize(doc)
    doc["updated"] = docops.now()
    pid = gen_profile_id()
    pname = unique_profile_name(session, user_id, book.book_id, name)
    session.add(Profile(user_id=user_id, book_id=book.book_id, profile_id=pid, name=pname,
                        doc_json=json.dumps(_without_cover(doc)), updated=doc["updated"]))
    #carry a cover over to a coverless external book, so an imported copy can supply the artwork
    cover = (doc.get("book") or {}).get("cover")
    if cover:
        covers.record_cover(session, user_id, book.book_id, "imported", cover, label="Imported file")
        if not (book.cover or ""):
            book.cover = cover
    book.updated = max(book.updated or 0, doc["updated"])
    return pid


def create_external_book(session, user_id, doc, *, title, authors, origin_id, profile_name="Main"):
    #create a fresh web-only "Imported" book from `doc`, with its first profile. returns the Book.
    doc = _normalize(doc)
    doc["updated"] = docops.now()
    meta = doc.get("book") or {}
    toc = meta.get("toc")
    bid = "ext-" + secrets.token_hex(8)
    book = Book(user_id=user_id, book_id=bid, source="external", origin_id=origin_id or bid,
                title=title or meta.get("title") or "Imported contexts",
                authors=authors or meta.get("authors") or "",
                cover=meta.get("cover") or "",  #cover travels embedded in the doc, no upload needed
                toc_json=json.dumps(toc) if isinstance(toc, list) and toc else "[]",
                reading_progress=doc.get("reading_progress"), updated=doc["updated"])
    session.add(book)
    session.add(Profile(user_id=user_id, book_id=bid, profile_id=DEFAULT_PID,
                        name=(profile_name or "Main").strip() or "Main",
                        doc_json=json.dumps(_without_cover(doc)), updated=doc["updated"]))
    if meta.get("cover"):  #record it as a selectable source so the cover picker can offer it
        covers.record_cover(session, user_id, bid, "imported", meta["cover"], label="Imported file")
    return book


def _toc(book):
    try:
        toc = json.loads(book.toc_json or "[]")
    except (ValueError, TypeError):
        toc = []
    return toc if isinstance(toc, list) else []


def compose(book, profile):
    #the full doc a client sees: the profile's notes, with the book's shared identity + reading position
    #+ chapter toc overlaid on top (so every profile of a book scrubs the same timeline).
    doc = _normalize(json.loads(profile.doc_json or "{}"))
    meta = dict(doc.get("book") or {})
    meta["id"] = book.book_id
    if book.title:
        meta["title"] = book.title
    if book.authors:
        meta["authors"] = book.authors
    if book.series:
        meta["series"] = book.series
    meta["series_index"] = book.series_index
    if book.cover:
        meta["cover"] = book.cover  #embed the cover so an exported doc carries its artwork (pure JSON)
    toc = _toc(book)
    if toc:
        meta["toc"] = toc
    doc["book"] = meta
    doc["source"] = book.source  #"device" or "external", so the web knows whether a missing timeline can be fixed by syncing koreader
    doc["reading_progress"] = book.reading_progress
    #advertise which profile this is so the client can label its picker
    doc["profile"] = {"id": profile.profile_id, "name": profile.name}
    return doc


def compose_or_transient(session, user_id, book, profile_id=DEFAULT_PID):
    #compose the doc for a profile, or — when the book has no such profile yet (e.g. a freshly adopted book
    #before its first context is added) — compose against a transient empty profile that is NOT persisted.
    #the book-level chapters/timeline/cover still come through, so the timeline works on an empty book.
    prof = get_profile(session, user_id, book.book_id, profile_id)
    if prof is None:
        prof = Profile(user_id=user_id, book_id=book.book_id, profile_id=profile_id,
                       name="Main" if profile_id == DEFAULT_PID else "Profile",
                       doc_json=json.dumps(new_doc()))
    return compose(book, prof)


def _idx0(v):
    #koreader's series index is 1 based (and maybe a float), the web stores it 0 based
    try:
        return max(0, int(round(float(v))) - 1)
    except (TypeError, ValueError):
        return 0


def ensure_book(session, user_id, book_id, *, title="", authors="", source="device"):
    book = _book(session, user_id, book_id)
    if book is None:
        book = Book(user_id=user_id, book_id=book_id, title=title, authors=authors, source=source)
        #a book sitting unstarted in the device library already has its cover (and series) resolved from
        #the device catalog, stored on its LibraryEntry. the first time it gains contexts it becomes a Book
        #and drops out of /library, so seed those over here, otherwise the cover the user was already
        #seeing vanishes (the device only sends cover bytes once, so it'd never come back on its own).
        entry = session.exec(
            select(LibraryEntry).where(LibraryEntry.user_id == user_id, LibraryEntry.book_id == book_id)
        ).first()
        if entry:
            book.cover = entry.cover or ""
            if not (book.title or "").strip() and entry.title:
                book.title = entry.title
            if not (book.authors or "").strip() and entry.authors:
                book.authors = entry.authors
            if entry.series:
                book.series = entry.series
                book.series_index = entry.series_index
        session.add(book)
        session.flush()
    return book


def ensure_profile(session, user_id, book_id, profile_id, *, name=None):
    #fetch a profile, creating an empty one if it's missing (used by sync when the device writes to a
    #profile that only exists on the device yet, and by adopt/import). `name` only seeds a brand-new
    #profile — it never renames an existing one, so a name set on the web isn't clobbered by the device
    #replaying its (possibly stale) local name on every push. device renames go through rename_profile.
    prof = get_profile(session, user_id, book_id, profile_id)
    if prof is None:
        prof = Profile(user_id=user_id, book_id=book_id, profile_id=profile_id,
                       name=name or ("Main" if profile_id == DEFAULT_PID else "Profile"),
                       doc_json=json.dumps(new_doc()))
        session.add(prof)
        session.flush()
        clear_profile_tombstone(session, user_id, book_id, profile_id)  #re-created -> it's no longer deleted
    return prof


def save_profile_doc(profile, book, merged, *, from_device):
    #store the merged doc on the profile, and push the book-level shared fields onto the Book. the device
    #(from_device) owns the reading position + chapter toc + book identity; the web only touches notes.
    profile.doc_json = json.dumps(_without_cover(merged))
    profile.updated = merged.get("updated") or profile.updated
    book.updated = max(book.updated or 0, merged.get("updated") or 0)
    if not from_device:
        return
    meta = merged.get("book") or {}
    if meta.get("title"):
        book.title = meta["title"]
    if meta.get("authors"):
        book.authors = meta["authors"]
    rp = merged.get("reading_progress")
    if isinstance(rp, (int, float)) and not isinstance(rp, bool):
        book.reading_progress = rp
    toc = meta.get("toc")
    if isinstance(toc, list) and toc and (not book.toc_json or book.toc_json == "[]"):
        book.toc_json = json.dumps(toc)
    #adopt koreader's series grouping, but never overwrite one the user set on the web
    series = meta.get("series")
    series = series.strip() if isinstance(series, str) else ""
    if series and not (book.series or "").strip():
        book.series = series
        book.series_index = _idx0(meta.get("series_index"))


def merge_into_profile(session, user_id, book_id, incoming, *, profile_id, profile_name=None,
                       from_device, title="", authors="", source="device"):
    #additively merge an incoming doc into a profile (creating the book/profile if needed), return the
    #composed full doc. this is the one path used by both the web's additive edits and device sync.
    book = ensure_book(session, user_id, book_id, title=title, authors=authors, source=source)
    prof = ensure_profile(session, user_id, book_id, profile_id, name=profile_name)
    base = json.loads(prof.doc_json or "{}")
    merged = merge(base, incoming or {})
    save_profile_doc(prof, book, merged, from_device=from_device)
    return book, prof, merged


def replace_profile(session, user_id, book_id, doc, *, profile_id):
    #web-authoritative replace of a profile's notes (undo/redo, node positions). sets the profile doc
    #exactly so deletes really remove things; never disturbs the shared book-level reading position.
    book = _book(session, user_id, book_id)
    prof = ensure_profile(session, user_id, book_id, profile_id)
    if book is None:
        book = ensure_book(session, user_id, book_id)
    merged = _normalize(doc or {})
    merged["updated"] = docops.now()
    save_profile_doc(prof, book, merged, from_device=False)
    return book, prof, merged
