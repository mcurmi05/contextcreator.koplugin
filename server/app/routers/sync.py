#device <-> server sync, authed by the account's username+password (HTTP Basic). the device pushes its book doc, the
#server additively merges it into what it has, persists the result, and hands the merged doc back
#for the device to write locally. all scoped to the token's owning user.
import json

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..db import get_session
from ..deps import get_sync_user
from ..models import Book, User
from ..sync import merge, new_doc

router = APIRouter(prefix="/api/sync", tags=["sync"])


def _load_doc(row: Book | None):
    if not row:
        return None
    try:
        return json.loads(row.doc_json)
    except (ValueError, TypeError):
        return None


@router.get("/books")
def list_sync_books(user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #cheap "what do you have and how fresh" list so the device knows what to pull
    rows = session.exec(select(Book).where(Book.user_id == user.id)).all()
    return [{"book_id": r.book_id, "updated": r.updated} for r in rows]


@router.get("/books/{book_id}")
def pull_book(book_id: str, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #authoritative server copy, an empty doc if we've never seen this book (device merges locally)
    row = session.exec(
        select(Book).where(Book.user_id == user.id, Book.book_id == book_id)
    ).first()
    return _load_doc(row) or new_doc()


@router.post("/books/{book_id}")
def push_book(book_id: str, body: dict, user: User = Depends(get_sync_user), session: Session = Depends(get_session)):
    #additively merge the device's doc into the stored one, save, return the merged result
    row = session.exec(
        select(Book).where(Book.user_id == user.id, Book.book_id == book_id)
    ).first()
    merged = merge(_load_doc(row) or {}, body or {})

    doc_json = json.dumps(merged)
    book_meta = merged.get("book") or {}
    title = book_meta.get("title") or ""
    authors = book_meta.get("authors") or ""
    updated = merged.get("updated") or 0

    #series grouping straight from koreader's metadata, so the web ui files the book on its own. the
    #device index is 1 based (and maybe a float), the web stores it 0 based.
    meta_series = book_meta.get("series")
    meta_series = meta_series.strip() if isinstance(meta_series, str) else ""

    def _idx0(v):
        try:
            return max(0, int(round(float(v))) - 1)
        except (TypeError, ValueError):
            return 0

    if row:
        row.doc_json = doc_json
        row.title = title or row.title
        row.authors = authors or row.authors
        row.updated = updated
        #adopt koreader's series, but never overwrite a grouping the user has set on the web
        if meta_series and not (row.series or "").strip():
            row.series = meta_series
            row.series_index = _idx0(book_meta.get("series_index"))
    else:
        row = Book(user_id=user.id, book_id=book_id, title=title, authors=authors,
                   series=meta_series, series_index=_idx0(book_meta.get("series_index")) if meta_series else 0,
                   doc_json=doc_json, updated=updated)
        session.add(row)
    session.commit()
    return merged
