from sqlmodel import Session, SQLModel, create_engine

from .config import settings

engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)

def init_db():
    #import models so their tables are registered before create_all
    from .. import models  # noqa: F401
    SQLModel.metadata.create_all(engine)
    _migrate()


def _migrate():
    #create_all never alters existing tables, so add columns introduced after a db already exists
    with engine.connect() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(book)")}
        if "series" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN series VARCHAR DEFAULT ''")
        if "series_index" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN series_index INTEGER DEFAULT 0")
        if "source" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN source VARCHAR DEFAULT 'device'")
        if "reading_progress" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN reading_progress FLOAT")
        if "toc_json" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN toc_json VARCHAR DEFAULT '[]'")
        if "origin_id" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN origin_id VARCHAR DEFAULT ''")
        if "cover" not in cols:
            conn.exec_driver_sql("ALTER TABLE book ADD COLUMN cover VARCHAR DEFAULT ''")
        #covers arrived on the device catalog after libraryentry already existed for some users
        le_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(libraryentry)")}
        if le_cols and "cover" not in le_cols:
            conn.exec_driver_sql("ALTER TABLE libraryentry ADD COLUMN cover VARCHAR DEFAULT ''")
        if le_cols and "series" not in le_cols:
            conn.exec_driver_sql("ALTER TABLE libraryentry ADD COLUMN series VARCHAR DEFAULT ''")
        if le_cols and "series_index" not in le_cols:
            conn.exec_driver_sql("ALTER TABLE libraryentry ADD COLUMN series_index INTEGER DEFAULT 0")
        #deviceposition gained chapter columns after the table already existed for some users
        dp_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(deviceposition)")}
        if dp_cols:  #table exists
            if "chapter" not in dp_cols:
                conn.exec_driver_sql("ALTER TABLE deviceposition ADD COLUMN chapter VARCHAR DEFAULT ''")
            if "chapter_frac" not in dp_cols:
                conn.exec_driver_sql("ALTER TABLE deviceposition ADD COLUMN chapter_frac FLOAT")
        #backfill covers onto started books that lost theirs before ensure_book learned to carry the cover
        #over when a library book first gains contexts. only fills an empty cover from a matching library
        #entry that actually has one, so it's idempotent and never clobbers a cover already set.
        if le_cols:
            conn.exec_driver_sql(
                "UPDATE book SET cover = ("
                "  SELECT le.cover FROM libraryentry le"
                "  WHERE le.user_id = book.user_id AND le.book_id = book.book_id"
                ") WHERE (book.cover IS NULL OR book.cover = '') AND EXISTS ("
                "  SELECT 1 FROM libraryentry le"
                "  WHERE le.user_id = book.user_id AND le.book_id = book.book_id AND le.cover != ''"
                ")"
            )
        conn.commit()
    _seed_default_profiles()


def _seed_default_profiles():
    #profiles arrived after books already stored a single doc. give every book that has no profile yet a
    #"default" profile carrying its existing notes, and lift the shared reading position + chapter toc up
    #onto the book. idempotent: a book that already has a profile is skipped.
    import json

    from sqlmodel import Session, select

    from ..models import Book, Profile

    with Session(engine) as session:
        books = session.exec(select(Book)).all()
        for b in books:
            has = session.exec(
                select(Profile).where(Profile.user_id == b.user_id, Profile.book_id == b.book_id)
            ).first()
            if has:
                continue
            try:
                doc = json.loads(b.doc_json or "{}")
            except (ValueError, TypeError):
                doc = {}
            if b.reading_progress is None:
                rp = doc.get("reading_progress")
                if isinstance(rp, (int, float)) and not isinstance(rp, bool):
                    b.reading_progress = rp
            if (not b.toc_json or b.toc_json == "[]"):
                toc = (doc.get("book") or {}).get("toc")
                if isinstance(toc, list) and toc:
                    b.toc_json = json.dumps(toc)
            session.add(Profile(user_id=b.user_id, book_id=b.book_id, profile_id="default",
                                name="Main", doc_json=b.doc_json or "{}", updated=b.updated or 0))
        session.commit()

def get_session():
    with Session(engine) as session:
        yield session
