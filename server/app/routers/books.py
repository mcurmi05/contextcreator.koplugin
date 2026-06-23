#a user's synced books, plus the view/edit endpoints the web ui uses. each book holds one or more named
#profiles (alternate context documents); endpoints that touch notes take a ?profile= query param (default
#"default"). book-level metadata (title/series) and the shared reading position live on the Book itself.
import json
import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import docops, profiles
from ..db import get_session
from ..deps import get_current_user
from ..models import Book, LibraryEntry, Profile, User
from ..profiles import DEFAULT_PID
from ..sync import _normalize, new_doc

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


@router.get("/books/{book_id}")
def get_book(book_id: str, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the full composed document for one profile, so the web ui can show what's been synced
    row = _get_row(session, user, book_id)
    prof = _get_profile(session, user, book_id, profile)
    return profiles.compose(row, prof)


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


@router.get("/export")
def export_all(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #a self-contained bundle of all this user's books, each with all its profiles
    rows = session.exec(select(Book).where(Book.user_id == user.id)).all()
    out = []
    for b in rows:
        profs = profiles.list_profiles(session, user.id, b.book_id)
        prof_dump = [{"profile_id": p.profile_id, "name": p.name, "doc": profiles.compose(b, p)} for p in profs]
        out.append({
            "book_id": b.book_id, "title": b.title, "authors": b.authors,
            "series": b.series, "series_index": b.series_index,
            "profiles": prof_dump,
            #default profile doc kept under "doc" too, so older importers still read something
            "doc": next((p["doc"] for p in prof_dump if p["profile_id"] == DEFAULT_PID), prof_dump[0]["doc"] if prof_dump else new_doc()),
        })
    return {"type": "context-creator-export", "version": 2, "books": out}


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
    #start a (device-bound) contexts book for a device book that has none yet, with a default profile.
    existing = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
    if existing:
        prof = profiles.ensure_profile(session, user.id, book_id, DEFAULT_PID)
        session.commit()
        return profiles.compose(existing, prof)
    entry = session.exec(select(LibraryEntry).where(LibraryEntry.user_id == user.id, LibraryEntry.book_id == book_id)).first()
    title = entry.title if entry else ""
    authors = entry.authors if entry else ""
    cover = entry.cover if entry else ""
    #seed the web grouping from the book's own metadata series; the user can still re-group by dragging
    series = entry.series if entry else ""
    series_index = entry.series_index if entry else 0
    book = Book(user_id=user.id, book_id=book_id, title=title, authors=authors, cover=cover,
                series=series, series_index=series_index, source="device", updated=docops.now())
    session.add(book)
    doc = new_doc()
    doc["book"] = {"id": book_id, "title": title, "authors": authors}
    doc["updated"] = docops.now()
    prof = Profile(user_id=user.id, book_id=book_id, profile_id=DEFAULT_PID, name="Main",
                   doc_json=json.dumps(doc), updated=doc["updated"])
    session.add(prof)
    session.commit()
    return profiles.compose(book, prof)


@router.post("/books/{book_id}/contexts")
def add_context(book_id: str, body: ContextIn, profile: str = DEFAULT_PID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    prof = _get_profile(session, user, book_id, profile)
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
