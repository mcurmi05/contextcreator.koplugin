from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..deps import get_current_user
from ..models import Device, User
from ..security import generate_token, hash_token

router = APIRouter(prefix="/api", tags=["devices"])

class DeviceIn(BaseModel):
    name: str | None = None

@router.post("/devices")
def create_device(body: DeviceIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    #mint a sync token, store only its hash, and return the token once for the user to paste into koreader
    token = generate_token()
    device = Device(user_id=user.id, name=(body.name or "device"), token_hash=hash_token(token))
    session.add(device)
    session.commit()
    session.refresh(device)
    return {"id": device.id, "name": device.name, "token": token}

@router.get("/devices")
def list_devices(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    devices = session.exec(select(Device).where(Device.user_id == user.id)).all()
    return [{"id": d.id, "name": d.name, "created": d.created.isoformat()} for d in devices]
