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
