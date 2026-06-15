import hashlib
import secrets

from argon2 import PasswordHasher

_ph = PasswordHasher()

def hash_password(password: str) -> str:
    return _ph.hash(password)

def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except Exception:
        #VerifyMismatchError and any malformed-hash error both mean "no"
        return False

def generate_token() -> str:
    #shown to the user once, then only its hash is kept
    return secrets.token_urlsafe(32)

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
