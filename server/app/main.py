from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from .core.config import resolve_secret_key
from .core.db import init_db
from .routers import auth, books, sync, users

#serve the built react app (app/web) when present, fall back to the plain login stub (app/static)
#for local `uvicorn` runs without a frontend build (use `npm run dev` for live frontend work).
_WEB_DIR = Path(__file__).parent / "web"
STATIC_DIR = (_WEB_DIR if _WEB_DIR.is_dir() else Path(__file__).parent / "static").resolve()

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


#serve a built asset when the path points at a real file, otherwise hand back index.html so the client
#-side router (history API) can handle deep links like /home or /<bookId>/<profileName> on refresh. the
#api routers above are matched first; this catch-all only sees everything they didn't claim.
@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404)  #unknown api path: 404, don't return HTML
    candidate = (STATIC_DIR / full_path).resolve()
    if full_path and candidate.is_file() and STATIC_DIR in candidate.parents:
        return FileResponse(candidate)  #a real asset (js/css/images)
    return FileResponse(STATIC_DIR / "index.html")  #a client route -> the SPA shell
