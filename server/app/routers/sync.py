#device <-> server sync, authed by the account's username+password (HTTP Basic). the device pushes one
#profile's book doc, the server additively merges it into what it has, persists the result, and hands the
#merged doc back for the device to write locally. a book can hold several named profiles; the device picks
#which it's reading/writing and passes it as ?profile= (default "default"). all scoped to the token's user.
import base64

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..services import profiles
from ..core.db import get_session
from ..core.deps import get_sync_user
from ..models import Book, LibraryEntry, Profile, User
from ..services.profiles import DEFAULT_PID
from ..services.sync import new_doc

router = APIRouter(prefix="/api/sync", tags=["sync"])

#a grayscale e-ink device (e.g. a Kobo) renders + extracts covers in black & white, while a colour screen
#(e.g. KOReader on a mac) extracts them in colour. covers sync last-write-wins, so without this a Kobo
#sync would overwrite the colour covers with grayscale ones. we tell them apart by the jpeg's component
#count (1 = grayscale, 3 = colour) and never let a grayscale cover replace a colour one.
_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg_is_color(data_url: str) -> bool:
    #scan a data: jpeg for its SOF marker and read the component count. unknown/odd data counts as colour
    #so a real cover is never wrongly blocked.
    if not data_url or not isinstance(data_url, str) or "," not in data_url:
        return True
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1])
    except Exception:
        return True
    i, n = 2, len(raw)  # skip the SOI marker (FFD8)
    while i + 1 < n:
        if raw[i] != 0xFF:
            i += 1
            continue
        while i + 1 < n and raw[i + 1] == 0xFF:  # collapse fill bytes
            i += 1
        if i + 1 >= n:
            break
        marker = raw[i + 1]
        if marker == 0x00 or marker == 0xD8 or marker == 0xD9 or 0xD0 <= marker <= 0xD7:
            i += 2  # standalone / stuffed marker, no length field
            continue
        if marker in _SOF_MARKERS:
            return i + 9 >= n or raw[i + 9] >= 3  # components count sits at +9 in the SOF segment
        if i + 3 >= n:
            break
        seglen = (raw[i + 2] << 8) | raw[i + 3]
        if seglen < 2:
            break
        i += 2 + seglen
    return True


def _should_replace_cover(existing: str, incoming: str, incoming_color: bool) -> bool:
    #a colour cover always wins; a grayscale cover is only used when there isn't already a colour one
    if not incoming:
        return False
    if incoming_color:
        return True
    return not (existing and _jpeg_is_color(existing))


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


@router.patch("/books/{book_id}/profiles/{profile_id}")
def rename_sync_profile(book_id: str, profile_id: str, body: dict, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #rename a profile from the device, so a rename made in koreader reaches the web (and other devices).
    name = (body.get("name") if isinstance(body, dict) else None) or ""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="name required")
    prof = profiles.get_profile(session, user.id, book_id, profile_id)
    if not prof:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="profile not found")
    prof.name = name
    session.commit()
    return {"profile_id": profile_id, "name": name}


@router.delete("/books/{book_id}/profiles/{profile_id}")
def delete_sync_profile(book_id: str, profile_id: str, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #delete a profile from the device. mirrors the web delete: if it was the last profile, drop the Book too.
    rows = profiles.list_profiles(session, user.id, book_id)
    prof = next((p for p in rows if p.profile_id == profile_id), None)
    if not prof:
        return {"deleted": profile_id, "book_removed": False}  #already gone; treat as success
    profiles.tombstone_profile(session, user.id, book_id, profile_id, prof.updated)  #don't let it resurrect
    session.delete(prof)
    book_removed = not [r for r in rows if r.profile_id != profile_id]
    if book_removed:
        book = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
        if book:
            session.delete(book)
    session.commit()
    return {"deleted": profile_id, "book_removed": book_removed}


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
        incoming_color = _jpeg_is_color(cover) if cover else False
        series = it.get("series") or ""
        sidx = int(it.get("series_index") or 0)
        row = session.exec(
            select(LibraryEntry).where(LibraryEntry.user_id == user.id, LibraryEntry.book_id == bid)
        ).first()
        if row:
            row.title = it.get("title") or row.title
            row.authors = it.get("authors") or row.authors
            if _should_replace_cover(row.cover or "", cover, incoming_color):
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
        #a freshly extracted cover overwrites the old one — unless it's a grayscale cover that would replace a
        #colour one (a grayscale device can't improve on a colour cover synced from a colour screen).
        book = session.exec(
            select(Book).where(Book.user_id == user.id, Book.book_id == bid)
        ).first()
        if book and _should_replace_cover(book.cover or "", cover, incoming_color):
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
    #if this profile was deleted (on the web or another device), don't let an additive push resurrect it.
    #only a push carrying real content with a strictly newer `updated` than the deleted version counts as a
    #genuine post-delete edit and is allowed through (lifting the tombstone). otherwise hand back an empty
    #doc so the device adopts it and clears its local copy, and the deletion sticks on both sides.
    version = profiles.profile_tombstone_version(session, user.id, book_id, profile)
    if version is not None:
        inc = body or {}
        has_content = bool(inc.get("contexts")) or bool(inc.get("relationships"))
        inc_updated = inc.get("updated")
        inc_updated = inc_updated if isinstance(inc_updated, (int, float)) and not isinstance(inc_updated, bool) else 0
        if not (has_content and inc_updated > version):
            session.commit()
            return new_doc()
        profiles.clear_profile_tombstone(session, user.id, book_id, profile)  #genuine newer edit -> resurrect
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
