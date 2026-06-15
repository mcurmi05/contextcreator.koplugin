#first-run account setup + session-cookie login for the web frontend
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..deps import get_current_user
from ..models import User
from ..security import hash_password, verify_password

router = APIRouter(prefix="/api", tags=["auth"])

class Credentials(BaseModel):
    username: str
    password: str

def _has_any_user(session: Session) -> bool:
    return session.exec(select(User)).first() is not None

@router.get("/setup")
def setup_status(session: Session = Depends(get_session)):
    return {"needs_setup": not _has_any_user(session)}

@router.post("/setup")
def setup(body: Credentials, request: Request, session: Session = Depends(get_session)):
    if _has_any_user(session):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="setup already complete")
    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="username and password required")
    user = User(username=username, password_hash=hash_password(body.password))
    session.add(user)
    session.commit()
    session.refresh(user)
    request.session["user_id"] = user.id  #log them straight in
    return {"id": user.id, "username": user.username}

@router.post("/auth/login")
def login(body: Credentials, request: Request, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == body.username)).first()
    if not user or not verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid username or password")
    request.session["user_id"] = user.id
    return {"id": user.id, "username": user.username}

@router.post("/auth/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}

@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username}
