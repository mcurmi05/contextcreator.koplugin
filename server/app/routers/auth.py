#first-run account setup + session-cookie login for the web frontend
import json
import time

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..core.db import get_session
from ..core.deps import admin_user_id, get_current_user
from ..models import User, UserPref
from ..core.security import hash_password, verify_password

router = APIRouter(prefix="/api", tags=["auth"])

class Credentials(BaseModel):
    username: str
    password: str

class AccountUpdate(BaseModel):
    current_password: str
    new_username: str | None = None
    new_password: str | None = None

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
def me(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return {"id": user.id, "username": user.username, "is_admin": user.id == admin_user_id(session)}

@router.get("/prefs")
def get_prefs(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #the user's web UI preferences (home page layout). returns {} until they've saved any.
    row = session.exec(select(UserPref).where(UserPref.user_id == user.id)).first()
    if not row:
        return {}
    try:
        return json.loads(row.home_json or "{}")
    except (ValueError, TypeError):
        return {}

@router.put("/prefs")
def put_prefs(body: dict = Body(...), user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #replace the user's home-page preferences with the posted object (kept opaque to the server)
    row = session.exec(select(UserPref).where(UserPref.user_id == user.id)).first()
    if not row:
        row = UserPref(user_id=user.id)
    row.home_json = json.dumps(body or {})
    row.updated = int(time.time())
    session.add(row)
    session.commit()
    return {"ok": True}

@router.post("/account")
def update_account(body: AccountUpdate, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #change your own username and/or password, gated on re-entering your current password
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="current password is incorrect")
    if body.new_username is not None and body.new_username.strip():
        new_username = body.new_username.strip()
        clash = session.exec(select(User).where(User.username == new_username)).first()
        if clash and clash.id != user.id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="username already taken")
        user.username = new_username
    if body.new_password:
        user.password_hash = hash_password(body.new_password)
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"id": user.id, "username": user.username, "is_admin": user.id == admin_user_id(session)}
