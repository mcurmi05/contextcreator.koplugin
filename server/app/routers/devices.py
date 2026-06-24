#device management: list the devices that have synced to this account and rename them. a device's name
#shows everywhere it appears (timeline "jump to current", cover picker, cover settings), and names are
#unique per account.
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from ..core.db import get_session
from ..core.deps import get_current_user
from ..models import User
from ..services import devices

router = APIRouter(prefix="/api", tags=["devices"])


class DeviceRename(BaseModel):
    name: str


@router.get("/devices")
def list_devices(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return devices.list_devices(session, user.id)


@router.put("/devices/{device_id}")
def rename_device(device_id: str, body: DeviceRename, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    try:
        name = devices.rename(session, user.id, device_id, body.name)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    session.commit()
    return {"device_id": device_id, "name": name}
