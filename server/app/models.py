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

class Book(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id", name="uq_user_book"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    book_id: str = Field(index=True)
    title: str = ""
    authors: str = ""
    series: str = ""          #optional grouping label, set from the web ui
    series_index: int = 0     #order within the series (left to right)
    source: str = "device"    #"device" syncs to koreader, "external" is a web-only imported doc
    doc_json: str = "{}"
    updated: int = 0

#a book known to be on the koreader device (from its read history) that may not have a contexts doc yet.
#lets the web ui offer "start a context for a book you haven't taken notes on".
class LibraryEntry(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id", name="uq_user_library"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    book_id: str = Field(index=True)
    title: str = ""
    authors: str = ""
    updated: int = 0
