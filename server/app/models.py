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

#book-level metadata, shared across all of a book's profiles. the actual notes (contexts/relationships)
#live in Profile rows. reading position + chapter timeline are book-level too, so every profile of a
#book scrubs against the same timeline.
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
    origin_id: str = ""       #for external books: the underlying book identity, so imports/copies of the
                              #same book group into one entry (with several profiles) instead of many
    reading_progress: float | None = None  #shared device reading position (0..1) for the timeline
    toc_json: str = "[]"      #shared chapter snapshot for the timeline bands
    doc_json: str = "{}"      #legacy pre-profiles single doc, migrated into a "default" profile
    updated: int = 0          #freshest profile change, so clients can cheaply tell something moved


#one named context document per book. a user can keep several (e.g. "Main", "Spoiler-free reread"),
#picking which to view/edit on the web and which to read/write on the device independently. holds only
#the notes (contexts/relationships/layout/tombstones); book meta + timeline come from the Book.
class Profile(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "book_id", "profile_id", name="uq_user_book_profile"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    book_id: str = Field(index=True)
    profile_id: str = Field(index=True)  #stable token, "default" for the original/migrated one
    name: str = "Main"
    doc_json: str = "{}"
    updated: int = 0
    created: datetime = Field(default_factory=_now)

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
