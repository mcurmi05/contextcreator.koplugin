import os
import secrets

from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CONTEXT_", env_file=".env", extra="ignore")
    secret_key: str | None = None
    db_path: str = "contextcreator.db"

settings = Settings()

def resolve_secret_key() -> str:
    if settings.secret_key:
        return settings.secret_key
    key_path = os.path.join(os.path.dirname(settings.db_path) or ".", "secret_key")
    if os.path.exists(key_path):
        with open(key_path) as f:
            existing = f.read().strip()
        if existing:
            return existing
    key = secrets.token_urlsafe(48)
    os.makedirs(os.path.dirname(key_path) or ".", exist_ok=True)
    with open(key_path, "w") as f:
        f.write(key)
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return key
