from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..db import get_session
from ..deps import get_current_user
from ..models import Book, User

router = APIRouter(prefix="/api", tags=["books"])

@router.get("/books")
def list_books(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    books = session.exec(select(Book).where(Book.user_id == user.id)).all()
    return [
        {"book_id": b.book_id, "title": b.title, "authors": b.authors, "updated": b.updated}
        for b in books
    ]
