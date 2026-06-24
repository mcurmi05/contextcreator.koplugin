#device identity: each connecting device has a stable device_id and a name. by default that's the model
#name the device reports, but the user can rename it (names are unique per account) and that name then
#shows everywhere — the timeline "jump to current" picker, the cover picker, and the cover settings. the
#name is denormalised onto DevicePosition.device_name and BookCover.label, and re-applied on every sync.
from sqlmodel import select

from ..models import BookCover, Device, DevicePosition


def custom_name(session, user_id, device_id):
    #the user-set name for a device, or None if they haven't renamed it
    row = session.exec(select(Device).where(Device.user_id == user_id, Device.device_id == device_id)).first()
    return row.name if row and row.name else None


def resolve_name(session, user_id, device_id, fallback):
    #the name to store for a device on a sync: the user's custom name wins, else the reported model name
    return custom_name(session, user_id, device_id) or (fallback or "KOReader")


def list_devices(session, user_id):
    #every device the account has seen — by reading position and/or by cover source — with its current
    #name. freshest (most recently active) first where we can tell.
    names, last_seen = {}, {}
    for dp in session.exec(select(DevicePosition).where(DevicePosition.user_id == user_id)).all():
        if not dp.device_id:
            continue
        last_seen[dp.device_id] = max(last_seen.get(dp.device_id, 0), dp.updated or 0)
        if dp.device_name:
            names[dp.device_id] = dp.device_name
    #cover sources are devices too (a device may have synced covers but not a reading position)
    for source, label in session.exec(select(BookCover.source, BookCover.label).where(BookCover.user_id == user_id)).all():
        if source and not source.startswith("custom") and source not in ("imported", "device"):
            names.setdefault(source, label or source)
            last_seen.setdefault(source, 0)
    #user-set names always win
    for d in session.exec(select(Device).where(Device.user_id == user_id)).all():
        if d.device_id and d.name:
            names[d.device_id] = d.name
            last_seen.setdefault(d.device_id, 0)
    out = [{"device_id": did, "name": names.get(did, did)} for did in last_seen]
    out.sort(key=lambda d: -last_seen.get(d["device_id"], 0))
    return out


def rename(session, user_id, device_id, name):
    #set a device's name (unique per account) and propagate it to the denormalised copies. returns the name.
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    clash = session.exec(select(Device).where(
        Device.user_id == user_id, Device.name == name, Device.device_id != device_id)).first()
    if clash:
        raise ValueError("another device already has that name")
    row = session.exec(select(Device).where(Device.user_id == user_id, Device.device_id == device_id)).first()
    if row:
        row.name = name
    else:
        session.add(Device(user_id=user_id, device_id=device_id, name=name))
    #back-fill the name everywhere it's stored, so it shows immediately without waiting for a re-sync
    for dp in session.exec(select(DevicePosition).where(
            DevicePosition.user_id == user_id, DevicePosition.device_id == device_id)).all():
        dp.device_name = name
    for bc in session.exec(select(BookCover).where(
            BookCover.user_id == user_id, BookCover.source == device_id)).all():
        bc.label = name
    return name
