#admin-only user management: list accounts and add new ones. each user has their own isolated set of
#books/contexts (all book rows are scoped by user_id). the admin is simply the first account created.
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..deps import admin_user_id, require_admin
from ..models import User
from ..security import hash_password

router = APIRouter(prefix="/api/users", tags=["users"])


class NewUser(BaseModel):
    username: str
    password: str


@router.get("")
def list_users(_: User = Depends(require_admin), session: Session = Depends(get_session)):
    admin_id = admin_user_id(session)
    rows = session.exec(select(User).order_by(User.id)).all()
    return [{"id": r.id, "username": r.username, "is_admin": r.id == admin_id} for r in rows]


@router.post("")
def create_user(body: NewUser, _: User = Depends(require_admin), session: Session = Depends(get_session)):
    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="username and password required")
    if session.exec(select(User).where(User.username == username)).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="username already taken")
    user = User(username=username, password_hash=hash_password(body.password))
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"id": user.id, "username": user.username, "is_admin": False}
