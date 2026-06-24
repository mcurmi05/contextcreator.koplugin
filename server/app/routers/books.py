#a user's synced books, plus the view/edit endpoints the web ui uses. each book holds one or more named
#profiles (alternate context documents); endpoints that touch notes take a ?profile= query param (default
#"default"). book-level metadata (title/series) and the shared reading position live on the Book itself.
import io
import json
import secrets
import time
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..services import covers, docops, profiles
from ..core.db import get_session
from ..core.deps import get_current_user
from ..models import Book, LibraryEntry, Profile, User
from ..services.profiles import DEFAULT_PID
from ..services.sync import _normalize, new_doc

router = APIRouter(prefix="/api", tags=["books"])


class ContextIn(BaseModel):
    title: str
    type: str | None = None
    progress: float | None = None  #0..1 timeline spot the web ui was scrubbed to when adding


class PointIn(BaseModel):
    text: str
    progress: float | None = None


class PointEdit(BaseModel):
    text: str
    id: str | None = None
    index: int | None = None


class ProfileIn(BaseModel):
    name: str
    copy_from: str | None = None  #profile_id to duplicate notes from (else a blank profile)


class ProfileRename(BaseModel):
    name: str


class BookMeta(BaseModel):
    series: str | None = None       #grouping name; "" clears it
    series_index: int | None = None  #0-based position (the home page shows it +1)


class CoverChoiceIn(BaseModel):
    source: str = ""  #which cover source to show (a device id / "custom"); "" = automatic (freshest)


class CustomCoverIn(BaseModel):
    cover: str  #a data: url for the uploaded cover


class SetAllCoversIn(BaseModel):
    source: str  #a device source to apply to every book that has a cover from it


class SetManyCoversIn(BaseModel):
    source: str            #a device source
    book_ids: list[str]    #the chosen books to apply it to


def _get_row(session, user, book_id) -> Book:
    row = session.exec(
        select(Book).where(Book.user_id == user.id, Book.book_id == book_id)
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="book not found")
    return row


def _get_profile(session, user, book_id, profile_id) -> Profile:
    prof = profiles.get_profile(session, user.id, book_id, profile_id)
    if not prof:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="profile not found")
    return prof


@router.get("/books")
def list_books(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    books = session.exec(select(Book).where(Book.user_id == user.id)).all()
    out = []
    for b in books:
        profs = profiles.list_profiles(session, user.id, b.book_id)
        out.append({
            "book_id": b.book_id, "title": b.title, "authors": b.authors, "cover": b.cover,
            "series": b.series, "series_index": b.series_index, "source": b.source, "updated": b.updated,
            "reading_progress": b.reading_progress,  #0..1 device reading position, for the home progress bar
            "profiles": [{"profile_id": p.profile_id, "name": p.name, "updated": p.updated} for p in profs],
        })
    return out


@router.get("/books/{book_id}/profiles")
def list_book_profiles(book_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    _get_row(session, user, book_id)
    rows = profiles.list_profiles(session, user.id, book_id)
    return [{"profile_id": p.profile_id, "name": p.name, "updated": p.updated} for p in rows]


@router.post("/books/{book_id}/profiles")
def create_profile(book_id: str, body: ProfileIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    _get_row(session, user, book_id)
    name = (body.name or "").strip() or "Profile"
    pid = profiles.gen_profile_id()
    doc = new_doc()
    if body.copy_from:
        src = _get_profile(session, user, book_id, body.copy_from)
        src_doc = _normalize(json.loads(src.doc_json or "{}"))
        #copy only the notes; the shared book meta / timeline come from the Book on read
        for f in ("contexts", "relationships", "layout", "tombstones"):
            doc[f] = src_doc.get(f, doc[f])
    doc["updated"] = docops.now()
    row = Profile(user_id=user.id, book_id=book_id, profile_id=pid, name=name,
                  doc_json=json.dumps(doc), updated=doc["updated"])
    session.add(row)
    session.commit()
    return {"profile_id": pid, "name": name, "updated": doc["updated"]}


@router.patch("/books/{book_id}/profiles/{profile_id}")
def rename_profile(book_id: str, profile_id: str, body: ProfileRename, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    prof = _get_profile(session, user, book_id, profile_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="name required")
    prof.name = name
    session.commit()
    return {"profile_id": prof.profile_id, "name": prof.name}


@router.delete("/books/{book_id}/profiles/{profile_id}")
def delete_profile(book_id: str, profile_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = profiles.list_profiles(session, user.id, book_id)
    prof = _get_profile(session, user, book_id, profile_id)
    #tombstone it so the device can't resurrect it on its next push (additive sync would otherwise re-add
    #the notes it still holds). the version is its current content so a genuinely newer edit can override.
    profiles.tombstone_profile(session, user.id, book_id, profile_id, prof.updated)
    session.delete(prof)
    #if that was the last profile, drop the Book itself. for a device book its library catalog entry
    #resurfaces so it shows "start contexts" again; an imported book is simply removed.
    book_removed = not [r for r in rows if r.profile_id != profile_id]
    if book_removed:
        book = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
        if book:
            session.delete(book)
    session.commit()
    return {"deleted": profile_id, "book_removed": book_removed}


@router.post("/books/{book_id}/profiles/{profile_id}/to-external")
def profile_to_external(book_id: str, profile_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #copy a profile's notes out into the standalone "Imported" set (web-only, not tied to any device). copies
    #from the same source book group into one Imported entry, this profile added alongside the others, so you
    #just pick between profiles there. the original profile is left untouched.
    row = _get_row(session, user, book_id)
    prof = _get_profile(session, user, book_id, profile_id)
    doc = _normalize(profiles.compose(row, prof))
    doc.pop("profile", None)  #drop the profile tag, this becomes a plain standalone doc
    base = row.title or (doc.get("book") or {}).get("title") or "Contexts"
    existing = profiles.find_external_by_origin(session, user.id, book_id)
    if existing:
        pid = profiles.add_external_profile(session, user.id, existing, doc, name=prof.name)
        target_id = existing.book_id
    else:
        book = profiles.create_external_book(session, user.id, doc, title=base,
                                             authors=row.authors, origin_id=book_id, profile_name=prof.name)
        target_id, pid = book.book_id, DEFAULT_PID
    session.commit()
    return {"book_id": target_id, "profile_id": pid, "title": base}


@router.get("/books/{book_id}/devices")
def list_book_devices(book_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #where each koreader device has read up to, so the timeline's "jump to current" can offer every
    #device's spot (not just whichever synced last). freshest device first.
    _get_row(session, user, book_id)
    rows = profiles.list_device_positions(session, user.id, book_id)
    return [{"device_id": r.device_id, "device_name": r.device_name,
             "reading_progress": r.reading_progress, "chapter": r.chapter,
             "chapter_frac": r.chapter_frac, "updated": r.updated} for r in rows]


@router.get("/covers")
def covers_overview(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #account-wide cover picture for the settings panel: device sources + each book's options & current
    return covers.overview(session, user.id)


@router.post("/covers/set-all")
def set_all_covers(body: SetAllCoversIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #point every book that has a cover from this device at it (one bulk action from settings)
    n = covers.set_all_to_source(session, user.id, body.source)
    session.commit()
    return {"updated": n}


@router.post("/covers/set-many")
def set_many_covers(body: SetManyCoversIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #point the chosen books at this device's cover (used by the home-page selection mode + Confirm)
    n = covers.set_many_to_source(session, user.id, body.source, body.book_ids or [])
    session.commit()
    return {"updated": n}


#the book must be something the user actually has (a started Book or a device library entry) before we'll
#read/change its covers. covers + the choice are user+book scoped, independent of profiles.
def _cover_book(session, user, book_id):
    if session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first():
        return
    if session.exec(select(LibraryEntry).where(LibraryEntry.user_id == user.id, LibraryEntry.book_id == book_id)).first():
        return
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="book not found")


@router.get("/books/{book_id}/covers")
def list_covers(book_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the cover options for this book (one per device that synced + any custom upload) and which is shown
    _cover_book(session, user, book_id)
    return covers.list_for_book(session, user.id, book_id)


@router.put("/books/{book_id}/cover")
def choose_cover(book_id: str, body: CoverChoiceIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #pick which source's cover to show
    _cover_book(session, user, book_id)
    covers.set_choice(session, user.id, book_id, body.source)
    cover = covers.resolve(session, user.id, book_id)
    session.commit()
    return {"cover": cover}


@router.post("/books/{book_id}/cover/custom")
def upload_cover(book_id: str, body: CustomCoverIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #add a custom cover (a data: url, downscaled client-side) under its own source, and switch to it. each
    #upload is a separate source, so a book can hold as many custom covers as the user wants.
    _cover_book(session, user, book_id)
    data = (body.cover or "").strip()
    if not data.startswith("data:"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="expected a data: url")
    if len(data) > 4_000_000:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="image too large")
    source = covers.CUSTOM_PREFIX + secrets.token_hex(4)
    covers.record_cover(session, user.id, book_id, source, data, label="Custom")
    covers.set_choice(session, user.id, book_id, source)
    cover = covers.resolve(session, user.id, book_id)
    session.commit()
    return {"cover": cover}


@router.delete("/books/{book_id}/cover/custom/{source}")
def delete_custom_cover(book_id: str, source: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #remove one custom cover (only custom uploads are removable; device covers just re-sync). if it was the
    #shown one, the choice resets and the book falls back to its first-synced cover.
    _cover_book(session, user, book_id)
    if not covers.is_custom(source):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="only custom covers can be removed")
    covers.remove_source(session, user.id, book_id, source)
    cover = covers.resolve(session, user.id, book_id)
    session.commit()
    return {"cover": cover}


@router.get("/books/{book_id}")
def get_book(book_id: str, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the full composed document for one profile, so the web ui can show what's been synced. a freshly
    #adopted book may have no profile yet (we create it lazily on the first context), so fall back to a
    #transient empty doc rather than 404 — the timeline still works off the book's chapters.
    row = _get_row(session, user, book_id)
    return profiles.compose_or_transient(session, user.id, row, profile)


@router.put("/books/{book_id}")
def replace_book(book_id: str, body: dict, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #web-authoritative replace of one profile's notes, used by undo/redo and node-position saves. unlike the
    #additive endpoints this sets the document exactly (so undo can genuinely remove things). the shared
    #book-level reading position / timeline is preserved untouched.
    _get_row(session, user, book_id)
    book, prof, _ = profiles.replace_profile(session, user.id, book_id, body or {}, profile_id=profile)
    session.commit()
    return profiles.compose(book, prof)


@router.patch("/books/{book_id}/meta")
def update_book_meta(book_id: str, body: BookMeta, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #let the user fix a book's series name / position by hand when koreader's metadata is wrong or missing.
    #for a started book the device won't clobber a web-set series, so the edit sticks; for an unstarted
    #library entry it can be overwritten by a later device catalog push (its series comes from metadata).
    book = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
    row = book or session.exec(
        select(LibraryEntry).where(LibraryEntry.user_id == user.id, LibraryEntry.book_id == book_id)
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="book not found")
    if body.series is not None:
        row.series = body.series.strip()
    if body.series_index is not None:
        row.series_index = max(0, int(body.series_index))
    if book:
        book.updated = int(time.time())
    session.add(row)
    session.commit()
    return {"series": row.series, "series_index": row.series_index}


def _export_items(session, user):
    #one export item per book, each carrying all its profiles. compose() embeds the cover in every doc's
    #book meta, and we also surface it top-level so the importer can restore the artwork (pure JSON, no
    #separate upload).
    rows = session.exec(select(Book).where(Book.user_id == user.id)).all()
    out = []
    for b in rows:
        profs = profiles.list_profiles(session, user.id, b.book_id)
        prof_dump = [{"profile_id": p.profile_id, "name": p.name, "doc": profiles.compose(b, p)} for p in profs]
        out.append({
            "book_id": b.book_id, "title": b.title, "authors": b.authors, "cover": b.cover,
            "series": b.series, "series_index": b.series_index,
            "profiles": prof_dump,
            #default profile doc kept under "doc" too, so older importers still read something
            "doc": next((p["doc"] for p in prof_dump if p["profile_id"] == DEFAULT_PID), prof_dump[0]["doc"] if prof_dump else new_doc()),
        })
    return out


def _safe_filename(name, fallback):
    #a filesystem-safe base name for a per-book file in the export zip
    keep = "".join(c if c.isalnum() or c in " -_." else "_" for c in (name or "")).strip(" .")
    return keep[:80] or fallback


@router.get("/export")
def export_all(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #a self-contained bundle of all this user's books, each with all its profiles
    return {"type": "context-creator-export", "version": 2, "books": _export_items(session, user)}


@router.get("/export.zip")
def export_zip(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the same data as /export, but as a zip with one importable JSON per book. unlike a single merged
    #bundle this keeps each book's cover intact, and the import side just takes a folder of these files.
    items = _export_items(session, user)
    buf = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for it in items:
            base = _safe_filename(it.get("title") or it.get("book_id"), it.get("book_id") or "book")
            fn, i = f"{base}.json", 2
            while fn in used:  #disambiguate same-titled books
                fn = f"{base} ({i}).json"
                i += 1
            used.add(fn)
            single = {"type": "context-creator-export", "version": 2, "books": [it]}
            z.writestr(fn, json.dumps(single))
    headers = {"Content-Disposition": 'attachment; filename="context-creator-contexts.zip"'}
    return Response(content=buf.getvalue(), media_type="application/zip", headers=headers)


def _import_book(session, user, book_id, item):
    #import one export item into the user's book additively (creating book + profiles as needed)
    title = item.get("title")
    authors = item.get("authors")
    profs = item.get("profiles") if isinstance(item.get("profiles"), list) else None
    if profs:
        for p in profs:
            d = p.get("doc") if isinstance(p, dict) and isinstance(p.get("doc"), dict) else None
            if d is None:
                continue
            profiles.merge_into_profile(session, user.id, book_id, d,
                                        profile_id=p.get("profile_id") or profiles.gen_profile_id(),
                                        profile_name=p.get("name"), from_device=False,
                                        title=title or "", authors=authors or "")
    else:
        doc = item.get("doc") if isinstance(item.get("doc"), dict) else {}
        profiles.merge_into_profile(session, user.id, book_id, doc, profile_id=DEFAULT_PID,
                                    from_device=False, title=title or "", authors=authors or "")
    #book-level series grouping from the bundle (web-set), applied to the Book
    book = profiles.ensure_book(session, user.id, book_id)
    if item.get("series") is not None:
        book.series = item.get("series") or ""
    if item.get("series_index") is not None:
        book.series_index = item.get("series_index") or 0
    #restore the cover (embedded in the export as a data: url) when this book doesn't already have one —
    #never clobber a real cover the device synced
    cover = item.get("cover") or ((item.get("doc") or {}).get("book") or {}).get("cover")
    if cover and not (book.cover or ""):
        book.cover = cover


@router.post("/import")
def import_all(body: dict, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #accepts an export bundle ({books:[...]}) or a single book doc; merges everything in additively
    items = body.get("books") if isinstance(body, dict) else None
    if not isinstance(items, list):
        if isinstance(body, dict) and isinstance(body.get("contexts"), dict):
            bk = body.get("book") or {}
            items = [{"book_id": bk.get("id"), "doc": body}]
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unrecognized import file")
    count = 0
    for item in items:
        doc = item.get("doc") if isinstance(item.get("doc"), dict) else {}
        book_id = item.get("book_id") or ((doc.get("book") or {}).get("id"))
        if not book_id:
            continue
        _import_book(session, user, book_id, item)
        count += 1
    session.commit()
    return {"imported": count}


@router.post("/books/{book_id}/import")
def import_book(book_id: str, body: dict, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #merge an uploaded doc into one profile of this book (e.g. importing a friend's notes). additive.
    _get_row(session, user, book_id)  #must already exist
    doc = body.get("doc") if isinstance(body, dict) and "contexts" not in body and isinstance(body.get("doc"), dict) else body
    book, prof, _ = profiles.merge_into_profile(session, user.id, book_id, doc, profile_id=profile, from_device=False)
    session.commit()
    return profiles.compose(book, prof)


@router.post("/external")
def import_external(body: dict, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #import a standalone contexts file (shared by someone else) as a web-only book, not tied to any device.
    #accepts a single book doc or an export bundle; each doc becomes its own "Imported" entry.
    docs = []
    items = body.get("books") if isinstance(body, dict) else None
    if isinstance(items, list):
        for it in items:
            d = it.get("doc") if isinstance(it, dict) and isinstance(it.get("doc"), dict) else None
            if d:
                docs.append((it.get("title"), it.get("authors"), d))
    elif isinstance(body, dict) and isinstance(body.get("contexts"), dict):
        docs.append((None, None, body))
    if not docs:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unrecognized contexts file")
    created = set()
    for title, authors, d in docs:
        doc = _normalize(d)
        meta = doc.get("book") or {}
        #group imports of the same underlying book (by its embedded id) into one Imported entry, the doc
        #joining as another profile instead of spawning a separate card
        origin = meta.get("id") if isinstance(meta.get("id"), str) and meta.get("id") else None
        existing = profiles.find_external_by_origin(session, user.id, origin) if origin else None
        if existing:
            profiles.add_external_profile(session, user.id, existing, doc, name=title or meta.get("title") or "Imported")
            created.add(existing.book_id)
        else:
            book = profiles.create_external_book(session, user.id, doc, title=title, authors=authors,
                                                 origin_id=origin, profile_name=title or "Main")
            created.add(book.book_id)
    session.commit()
    return {"imported": len(created), "book_ids": list(created)}


@router.post("/books/{target_id}/attach/{external_id}")
def attach_external(target_id: str, external_id: str, name: str | None = None, from_profile: str = DEFAULT_PID,
                    user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #attach one profile of an imported (external) book to an existing book as a NEW profile (named `name`),
    #then drop the external entry. the target book's own profiles are left untouched, the imported data just
    #becomes another profile alongside them.
    target = _get_row(session, user, target_id)
    ext = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == external_id)).first()
    if not ext:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="imported doc not found")
    ext_prof = profiles.get_profile(session, user.id, external_id, from_profile) \
        or profiles.get_profile(session, user.id, external_id, DEFAULT_PID)
    ext_doc = json.loads(ext_prof.doc_json) if ext_prof else {}
    new_name = profiles.unique_profile_name(session, user.id, target_id, name or ext.title or "Imported")
    new_pid = profiles.gen_profile_id()
    book, prof, _ = profiles.merge_into_profile(session, user.id, target_id, ext_doc,
                                                profile_id=new_pid, profile_name=new_name, from_device=False)
    #drop the external book + all its profiles, it now lives as a profile on the target
    for p in profiles.list_profiles(session, user.id, external_id):
        session.delete(p)
    session.delete(ext)
    session.commit()
    return {"book_id": target_id, "profile_id": new_pid, "name": new_name}


@router.get("/library")
def list_library(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #books known to be on the device (from its read history) that don't have a contexts book yet
    have = set(session.exec(select(Book.book_id).where(Book.user_id == user.id)).all())
    rows = session.exec(select(LibraryEntry).where(LibraryEntry.user_id == user.id)).all()
    return [{"book_id": r.book_id, "title": r.title, "authors": r.authors, "cover": r.cover,
             "series": r.series, "series_index": r.series_index}
            for r in rows if r.book_id not in have]


@router.post("/library/{book_id}/adopt")
def adopt_library_book(book_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #start a (device-bound) contexts book for a device book that has none yet. we create the Book (carrying
    #its catalog cover/series/title) but DON'T persist a Main profile yet — that's materialised lazily when
    #the first context is added, so opening-but-not-touching a book doesn't leave an empty profile behind.
    #the chapters/timeline live on the Book, so they're kept regardless of whether a profile exists.
    book = profiles.ensure_book(session, user.id, book_id)
    book.updated = book.updated or docops.now()
    session.commit()
    return profiles.compose_or_transient(session, user.id, book, DEFAULT_PID)


@router.post("/books/{book_id}/contexts")
def add_context(book_id: str, body: ContextIn, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    #the first context on a freshly adopted book is what actually materialises its Main profile
    prof = profiles.ensure_profile(session, user.id, book_id, profile)
    doc = profiles.compose(row, prof)
    key = docops.ensure_context(doc, body.title, body.type, body.progress)
    if not key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="title required")
    profiles.save_profile_doc(prof, row, doc, from_device=False)
    session.commit()
    return profiles.compose(row, prof)


@router.post("/books/{book_id}/contexts/{key}/points")
def add_point(book_id: str, key: str, body: PointIn, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    prof = _get_profile(session, user, book_id, profile)
    doc = profiles.compose(row, prof)
    if not docops.add_point(doc, key, body.text, body.progress):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="context not found or empty text")
    profiles.save_profile_doc(prof, row, doc, from_device=False)
    session.commit()
    return profiles.compose(row, prof)


@router.patch("/books/{book_id}/contexts/{key}/points")
def edit_point(book_id: str, key: str, body: PointEdit, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    prof = _get_profile(session, user, book_id, profile)
    doc = profiles.compose(row, prof)
    if not docops.edit_point(doc, key, body.text, body.id, body.index):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="point not found or empty text")
    profiles.save_profile_doc(prof, row, doc, from_device=False)
    session.commit()
    return profiles.compose(row, prof)
