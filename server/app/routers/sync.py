#device <-> server sync, authed by the account's username+password (HTTP Basic). the device pushes one
#profile's book doc, the server additively merges it into what it has, persists the result, and hands the
#merged doc back for the device to write locally. a book can hold several named profiles; the device picks
#which it's reading/writing and passes it as ?profile= (default "default"). all scoped to the token's user.
from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from .. import profiles
from ..db import get_session
from ..deps import get_sync_user
from ..models import Book, LibraryEntry, User
from ..profiles import DEFAULT_PID
from ..sync import new_doc

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.get("/books")
def list_sync_books(user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #cheap "what do you have and how fresh" list so the device knows what to pull. web-only imported
    #books are left out, they don't belong on any device.
    rows = session.exec(select(Book).where(Book.user_id == user.id, Book.source == "device")).all()
    return [{"book_id": r.book_id, "updated": r.updated} for r in rows]


@router.get("/books/{book_id}/profiles")
def list_book_profiles(book_id: str, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #the named profiles for a book, so the device can show them in its picker (and learn about ones made
    #on the web). always advertises the default so a fresh book still offers something to write to.
    rows = profiles.list_profiles(session, user.id, book_id)
    out = [{"profile_id": p.profile_id, "name": p.name, "updated": p.updated} for p in rows]
    if not any(p["profile_id"] == DEFAULT_PID for p in out):
        out.insert(0, {"profile_id": DEFAULT_PID, "name": "Main", "updated": 0})
    return out


@router.post("/library")
def push_library(body: list[dict], user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #the device reports its read-history catalog (book_id + title) so the web ui can offer to start a
    #context for a book that has no notes yet. upsert by book_id, scoped to the user.
    seen = 0
    need_cover = []  #book_ids the server still has no cover for, so the device knows to (re)send one
    for it in body or []:
        bid = it.get("book_id")
        if not bid:
            continue
        seen += 1
        cover = it.get("cover") or ""
        series = it.get("series") or ""
        sidx = int(it.get("series_index") or 0)
        row = session.exec(
            select(LibraryEntry).where(LibraryEntry.user_id == user.id, LibraryEntry.book_id == bid)
        ).first()
        if row:
            row.title = it.get("title") or row.title
            row.authors = it.get("authors") or row.authors
            if cover:
                row.cover = cover
            #only set series when the device actually sent one, so a later metadata-less push (e.g. a book
            #whose cover is already done) doesn't wipe a series we resolved earlier
            if series:
                row.series = series
                row.series_index = sidx
        else:
            row = LibraryEntry(user_id=user.id, book_id=bid, title=it.get("title") or "",
                               authors=it.get("authors") or "", cover=cover, series=series, series_index=sidx)
            session.add(row)
        #a book with notes lives as a Book (and is filtered out of /api/library), so push the cover there too.
        #a cover in the payload is always freshly extracted (first time or a changed one), so overwrite it.
        book = session.exec(
            select(Book).where(Book.user_id == user.id, Book.book_id == bid)
        ).first()
        if cover and book:
            book.cover = cover
        #tell the device to (re)send a cover when we have none, on either the library entry or the started
        #book. this makes covers self-heal after a server wipe/restore: the device's local "already sent"
        #memory wouldn't otherwise re-send to the same url, but an empty server here asks for them again.
        if not ((row.cover or "") or (book.cover if book else "")):
            need_cover.append(bid)
    session.commit()
    return {"ok": True, "count": seen, "need_cover": need_cover}


@router.get("/books/{book_id}")
def pull_book(book_id: str, profile: str = DEFAULT_PID, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #authoritative server copy of one profile, an empty doc if we've never seen it (device merges locally)
    book = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
    prof = profiles.get_profile(session, user.id, book_id, profile)
    if not book or not prof:
        return new_doc()
    return profiles.compose(book, prof)


@router.post("/books/{book_id}")
def push_book(book_id: str, body: dict, profile: str = DEFAULT_PID, name: str | None = None,
              device_id: str | None = None, device_name: str | None = None,
              device_chapter: str | None = None, device_chapter_frac: float | None = None,
              user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #additively merge the device's doc for one profile into the stored one, save, return the merged result.
    #this is the device-authoritative path: the device owns the reading position + chapter toc + book meta.
    book, prof, merged = profiles.merge_into_profile(
        session, user.id, book_id, body or {}, profile_id=profile, profile_name=name, from_device=True)
    #stamp this device's own reading position too (the shared one is last-write-wins), so the web can
    #later offer "jump to current" for whichever device the reader is actually on. the chapter lets the
    #web re-anchor it correctly even when the shared timeline was built by a different device.
    if device_id:
        profiles.record_device_position(session, user.id, book_id, device_id,
                                        merged.get("reading_progress"), device_name=device_name,
                                        chapter=device_chapter, chapter_frac=device_chapter_frac)
    session.commit()
    return profiles.compose(book, prof)
