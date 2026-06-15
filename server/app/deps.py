#auth dependencies: session-cookie user (web frontend) and credentials user (the koreader plugin,
#which sends the account's username+password as HTTP Basic auth on each sync request).
import base64
import binascii

from fastapi import Depends, HTTPException, Request, status
from sqlmodel import Session, select

from .db import get_session
from .models import User
from .security import verify_password


def get_current_user(request: Request, session: Session = Depends(get_session)) -> User:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not logged in")
    user = session.get(User, user_id)
    if not user:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not logged in")
    return user


def get_sync_user(request: Request, session: Session = Depends(get_session)) -> User:
    #the plugin sends `Authorization: Basic base64(username:password)`; verify against the account.
    #falls back to a logged-in web session so the frontend can hit sync endpoints too.
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad credentials")
        username, sep, password = decoded.partition(":")
        if sep:
            user = session.exec(select(User).where(User.username == username)).first()
            if user and verify_password(user.password_hash, password):
                return user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid username or password")

    #no basic auth -> try the web session cookie
    user_id = request.session.get("user_id")
    if user_id:
        user = session.get(User, user_id)
        if user:
            return user
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
