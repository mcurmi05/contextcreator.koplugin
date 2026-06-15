from datetime import datetime, timezone

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel

def _now():
    return datetime.now(timezone.utc)

class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    created: datetime = Field(default_factory=_now)

class Device(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str = "device"
    token_hash: str = Field(index=True, unique=True)
    created: datetime = Field(default_factory=_now)

class Book(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id", name="uq_user_book"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    book_id: str = Field(index=True)
    title: str = ""
    authors: str = ""
    doc_json: str = "{}"
    updated: int = 0  
