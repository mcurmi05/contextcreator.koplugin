from sqlmodel import Session, SQLModel, create_engine

from .config import settings

engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)

def init_db():
    #import models so their tables are registered before create_all
    from . import models  # noqa: F401
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
        conn.commit()

def get_session():
    with Session(engine) as session:
        yield session
