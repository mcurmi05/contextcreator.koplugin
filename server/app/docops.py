#document edit helpers for the web ui: add a context / add a dot point to the stored doc. these mirror
#the device's data model so web-made entries merge cleanly with the device (context key = normalized
#title, points carry a stable id). edits are purely additive, matching the sync philosophy.
import re
import secrets
import string
import time

from .sync import _normalize

_PUNCT = re.escape(string.punctuation)


def now():
    return int(time.time())


def gen_id():
    #web-origin point id; just needs to be unique (the "w" prefix marks where it came from)
    return "w-" + secrets.token_hex(8)


def normalize_word(word):
    #mirror of ContextText.normalizeWord on the device so the same title maps to the same key
    if not word:
        return ""
    word = re.sub(r"\s+", " ", word).strip().lower()
    word = word.replace("’", "'")                       #curly apostrophe -> straight
    word = re.sub(rf"^[{_PUNCT}]+", "", word)                #trim leading punctuation
    word = re.sub(rf"[{_PUNCT}]+$", "", word)                #trim trailing punctuation
    word = re.sub(r"'s$", "", word)                          #possessive 's
    if len(word) > 3:
        word = re.sub(r"s$", "", word)                       #plural/trailing s on longer words
    return word


def ensure_context(doc, title, type_=None):
    #create (or touch) a context for `title`; returns its key, or None if the title is empty
    _normalize(doc)
    key = normalize_word(title)
    if not key:
        return None
    ts = now()
    ctx = doc["contexts"].get(key)
    if ctx:
        if type_:
            ctx["type"] = type_
            ctx["updated"] = ts
    else:
        doc["contexts"][key] = {
            "title": (title or "").strip(),
            "type": type_ or "unset",
            "points": [],
            "updated": ts,
        }
    doc["tombstones"]["contexts"].pop(key, None)  #re-create overrides any old deletion
    doc["updated"] = ts
    return key


def add_point(doc, key, text):
    #append a dot point to an existing context; returns True if it landed
    _normalize(doc)
    ctx = doc["contexts"].get(key)
    if not ctx or not text:
        return False
    ts = now()
    ctx.setdefault("points", []).append({"id": gen_id(), "text": text})
    ctx["updated"] = ts
    doc["tombstones"]["contexts"].pop(key, None)
    doc["updated"] = ts
    return True


def edit_point(doc, key, text, point_id=None, index=None):
    #change a dot point's text in place, keeping its id so the merge treats it as the same point
    #(a one-sided edit wins by being the merge base; a concurrent device edit churns its own id and
    #still wins). returns True if a point was found and changed.
    _normalize(doc)
    ctx = doc["contexts"].get(key)
    if not ctx or not text:
        return False
    points = ctx.get("points") or []
    target = None
    if point_id is not None:
        target = next((p for p in points if isinstance(p, dict) and p.get("id") == point_id), None)
    if target is None and index is not None and 0 <= index < len(points):
        p = points[index]
        if not isinstance(p, dict):          #upgrade a legacy bare-string point to an object
            p = {"id": gen_id(), "text": str(p)}
            points[index] = p
        target = p
    if target is None:
        return False
    target["text"] = text
    target.setdefault("id", gen_id())
    ts = now()
    ctx["updated"] = ts
    doc["updated"] = ts
    return True
