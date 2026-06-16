from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from .config import resolve_secret_key
from .db import init_db
from .routers import auth, books, sync, users

#serve the built react app (app/web) when present; fall back to the plain login stub (app/static)
#for local `uvicorn` runs without a frontend build (use `npm run dev` for live frontend work).
_WEB_DIR = Path(__file__).parent / "web"
STATIC_DIR = _WEB_DIR if _WEB_DIR.is_dir() else Path(__file__).parent / "static"

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="Context Creator server", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=resolve_secret_key(), same_site="lax", https_only=False)
app.include_router(auth.router)
app.include_router(books.router)
app.include_router(sync.router)
app.include_router(users.router)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="frontend")
