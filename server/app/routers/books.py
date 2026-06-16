#a user's synced books, plus simple view/edit endpoints the web ui uses to add contexts and dot
#points (so you can test that web -> device sync works too). all session-authed (the logged-in user).
import json

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import docops
from ..db import get_session
from ..deps import get_current_user
from ..models import Book, User
from ..sync import merge

router = APIRouter(prefix="/api", tags=["books"])


class ContextIn(BaseModel):
    title: str
    type: str | None = None


class PointIn(BaseModel):
    text: str


class PointEdit(BaseModel):
    text: str
    id: str | None = None
    index: int | None = None


class BookMetaIn(BaseModel):
    series: str | None = None
    series_index: int | None = None


def _get_row(session, user, book_id) -> Book:
    row = session.exec(
        select(Book).where(Book.user_id == user.id, Book.book_id == book_id)
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="book not found")
    return row


def _save(session, row, doc):
    row.doc_json = json.dumps(doc)
    row.updated = doc.get("updated") or row.updated
    session.commit()
    return doc


@router.get("/books")
def list_books(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    books = session.exec(select(Book).where(Book.user_id == user.id)).all()
    return [
        {"book_id": b.book_id, "title": b.title, "authors": b.authors,
         "series": b.series, "series_index": b.series_index, "updated": b.updated}
        for b in books
    ]


@router.get("/books/{book_id}")
def get_book(book_id: str, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the full stored document, so the web ui can show what's been synced
    return json.loads(_get_row(session, user, book_id).doc_json)


@router.get("/export")
def export_all(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #a self-contained bundle of all this user's books + their context docs
    rows = session.exec(select(Book).where(Book.user_id == user.id)).all()
    return {
        "type": "context-creator-export", "version": 1,
        "books": [
            {"book_id": b.book_id, "title": b.title, "authors": b.authors,
             "series": b.series, "series_index": b.series_index, "doc": json.loads(b.doc_json)}
            for b in rows
        ],
    }


def _upsert_merge(session, user, book_id, doc, *, title=None, authors=None, series=None, series_index=None):
    #additively merge `doc` into the user's book (creating it if needed); never loses existing data
    row = session.exec(select(Book).where(Book.user_id == user.id, Book.book_id == book_id)).first()
    base = json.loads(row.doc_json) if row else {}
    merged = merge(base, doc or {})
    meta = merged.get("book") or {}
    new_title = title or meta.get("title") or (row.title if row else "")
    new_authors = authors or meta.get("authors") or (row.authors if row else "")
    if row:
        row.doc_json = json.dumps(merged)
        row.title = new_title
        row.authors = new_authors
        if series is not None:
            row.series = series
        if series_index is not None:
            row.series_index = series_index
        row.updated = merged.get("updated") or row.updated
    else:
        row = Book(user_id=user.id, book_id=book_id, title=new_title, authors=new_authors,
                   series=series or "", series_index=series_index or 0,
                   doc_json=json.dumps(merged), updated=merged.get("updated") or 0)
        session.add(row)
    return merged


@router.post("/import")
def import_all(body: dict, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #accepts an export bundle ({books:[...]}) or a single book doc; merges everything in additively
    items = body.get("books") if isinstance(body, dict) else None
    if not isinstance(items, list):
        #treat the body as one book doc
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
        _upsert_merge(session, user, book_id, doc,
                      title=item.get("title"), authors=item.get("authors"),
                      series=item.get("series"), series_index=item.get("series_index"))
        count += 1
    session.commit()
    return {"imported": count}


@router.patch("/books/{book_id}/meta")
def set_book_meta(book_id: str, body: BookMetaIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #set web-only book metadata (currently just the series grouping label)
    row = _get_row(session, user, book_id)
    if body.series is not None:
        row.series = body.series.strip()
    if body.series_index is not None:
        row.series_index = body.series_index
    session.commit()
    return {"book_id": row.book_id, "series": row.series, "series_index": row.series_index}


@router.post("/books/{book_id}/import")
def import_book(book_id: str, body: dict, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #merge an uploaded doc into this book (e.g. importing a friend's notes). additive, keeps both.
    _get_row(session, user, book_id)  #must already exist
    doc = body.get("doc") if isinstance(body, dict) and "contexts" not in body and isinstance(body.get("doc"), dict) else body
    merged = _upsert_merge(session, user, book_id, doc)
    session.commit()
    return merged


@router.post("/books/{book_id}/contexts")
def add_context(book_id: str, body: ContextIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    doc = json.loads(row.doc_json)
    key = docops.ensure_context(doc, body.title, body.type)
    if not key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="title required")
    return _save(session, row, doc)


@router.post("/books/{book_id}/contexts/{key}/points")
def add_point(book_id: str, key: str, body: PointIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    doc = json.loads(row.doc_json)
    if not docops.add_point(doc, key, body.text):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="context not found or empty text")
    return _save(session, row, doc)


@router.patch("/books/{book_id}/contexts/{key}/points")
def edit_point(book_id: str, key: str, body: PointEdit, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _get_row(session, user, book_id)
    doc = json.loads(row.doc_json)
    if not docops.edit_point(doc, key, body.text, body.id, body.index):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="point not found or empty text")
    return _save(session, row, doc)
