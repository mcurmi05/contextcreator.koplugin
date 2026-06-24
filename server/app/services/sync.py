#the additive merge at the heart of sync. given two versions of a book's document, produce one that
#loses nothing: union contexts (by key), relationships (by id) and dot points (by id), minus anything
#tombstoned. it's purely additive, so genuine conflicts duplicate rather than clobber:
#the device mints a NEW point id whenever a point's text is edited (tombstoning the old id), so two
#devices editing "the same" point independently end up with two points after merge, and the user
#deletes the loser later. scalar labels (title/type/label/direction) fall back to newest `updated`
#since those aren't content. a tombstoned context/relationship is dropped only if nothing live
#remains under it (a concurrent point added elsewhere keeps it alive). re-merging is idempotent.

EMPTY_TOMBSTONES = ("contexts", "relationships", "points")

#the doc schema this server writes. the schema history (1..3) only added fields / relaxed shapes that the
#code below already tolerates (bare-string + id-less points in _merge_points, missing tombstones/layout/
#`directed`), so an older doc needs no field rewrites — _normalize just fills the missing shape. a future
#breaking change adds an explicit, idempotent migration step (see _migrate_doc) keyed on the source
#version. a doc tagged with a NEWER schema keeps its higher version so a mixed fleet never silently
#downgrades each other.
SCHEMA_VERSION = 3


def _migrate_doc(doc, from_version):
    #hook for version-specific conversions of an older doc (none needed for 1..3 — all additive/tolerated).
    #future: `if from_version < 4: ...`. mutates and returns doc.
    return doc


def _normalize(doc):
    #be defensive about types: a client serializing an EMPTY array can send {} (a JSON object) instead
    #of [], so coerce each field to the shape the merge expects rather than trusting the input.
    doc = dict(doc or {})
    from_version = doc.get("schema") or 1
    _migrate_doc(doc, from_version)
    doc["schema"] = from_version if from_version > SCHEMA_VERSION else SCHEMA_VERSION
    doc["book"] = doc["book"] if isinstance(doc.get("book"), dict) else {}
    doc["updated"] = doc.get("updated") or 0
    doc["contexts"] = doc["contexts"] if isinstance(doc.get("contexts"), dict) else {}
    doc["relationships"] = doc["relationships"] if isinstance(doc.get("relationships"), list) else []
    doc["layout"] = doc["layout"] if isinstance(doc.get("layout"), dict) else {}  #web-set node positions
    rp = doc.get("reading_progress")  #0..1 fraction the device last read up to
    doc["reading_progress"] = rp if isinstance(rp, (int, float)) and not isinstance(rp, bool) else None
    t = doc.get("tombstones") if isinstance(doc.get("tombstones"), dict) else {}
    t = dict(t)
    for k in EMPTY_TOMBSTONES:
        t[k] = t[k] if isinstance(t.get(k), dict) else {}
    doc["tombstones"] = t
    return doc


def new_doc():
    return {
        "schema": SCHEMA_VERSION,
        "book": {},
        "updated": 0,
        "contexts": {},
        "relationships": [],
        "layout": {},
        "reading_progress": None,
        "tombstones": {"contexts": {}, "relationships": {}, "points": {}},
    }


def _merge_tombstones(a, b):
    out = {}
    for kind in EMPTY_TOMBSTONES:
        m = dict(a.get(kind) or {})
        for key, when in (b.get(kind) or {}).items():
            #keep the latest deletion time we've seen for this id
            if key not in m or (when or 0) > (m[key] or 0):
                m[key] = when
        out[kind] = m
    return out


def _merge_points(points_a, points_b, point_tombstones):
    #union by id, dropping tombstoned ids.
    by_id = {}
    loose_by_text = {}
    for p in list(points_a or []) + list(points_b or []):
        if not isinstance(p, dict):
            loose_by_text.setdefault(str(p), {"text": str(p)})  #bare-string legacy point
            continue
        pid = p.get("id")
        if pid is None:
            loose_by_text.setdefault(p.get("text", ""), p)  #dedup id-less points by text
            continue
        if pid in point_tombstones:
            continue
        by_id.setdefault(pid, p)  #first occurrence wins, same id means same content (edits churn ids)
    #an id-less point matching the text of an id'd one is the SAME point from before it had an id:
    #let the id'd version represent it. this stops a freshly-id'd device point from duplicating the
    #server's old id-less copy, and means the point can then be deleted via its id (tombstone).
    id_texts = {(p.get("text") or "") for p in by_id.values()}
    loose = [p for text, p in loose_by_text.items() if text not in id_texts]
    return list(by_id.values()) + loose


def _newer(a, b):
    #of two entity versions, the one with the larger `updated` (used for scalar label fields)
    if a is None:
        return b
    if b is None:
        return a
    return a if (a.get("updated") or 0) >= (b.get("updated") or 0) else b


def _merge_context(a, b, point_tombstones):
    primary = _newer(a, b)
    ctx = dict(primary)
    ctx["points"] = _merge_points(
        (a or {}).get("points"), (b or {}).get("points"), point_tombstones
    )
    ctx["updated"] = max((a or {}).get("updated") or 0, (b or {}).get("updated") or 0)
    return ctx


def _merge_relationship(versions, point_tombstones):
    primary = versions[0]
    for v in versions[1:]:
        primary = _newer(primary, v)
    rel = dict(primary)
    points = []
    for v in versions:
        points = _merge_points(points, v.get("points"), point_tombstones)
    rel["points"] = points
    rel["updated"] = max((v.get("updated") or 0) for v in versions)
    return rel


def _merge_book(a, b):
    book = {}
    for field in ("id", "title", "authors", "series"):
        book[field] = b.get(field) or a.get(field)
    #series_index can legitimately be 0/falsy, so pick by presence not truthiness (incoming/device wins)
    si = b.get("series_index")
    if si is None:
        si = a.get("series_index")
    if si is not None:
        book["series_index"] = si
    toc = b.get("toc") or a.get("toc")
    if toc:
        book["toc"] = toc
    return {k: v for k, v in book.items() if v is not None}


def merge(base, incoming):
    base = _normalize(base)
    incoming = _normalize(incoming)
    out = new_doc()
    out["tombstones"] = _merge_tombstones(base["tombstones"], incoming["tombstones"])
    point_tombs = out["tombstones"]["points"]

    #contexts: union by key
    for key in set(base["contexts"]) | set(incoming["contexts"]):
        ctx = _merge_context(base["contexts"].get(key), incoming["contexts"].get(key), point_tombs)
        tomb = out["tombstones"]["contexts"].get(key)
        #honour a deletion only when nothing live is left under this context
        if tomb is not None and not ctx["points"] and (ctx.get("updated") or 0) <= tomb:
            continue
        out["contexts"][key] = ctx

    #relationships: union by id
    versions = {}
    for rel in base["relationships"] + incoming["relationships"]:
        rid = rel.get("id")
        if rid is None:
            continue
        versions.setdefault(rid, []).append(rel)
    for rid, vs in versions.items():
        rel = _merge_relationship(vs, point_tombs)
        tomb = out["tombstones"]["relationships"].get(rid)
        if tomb is not None and not rel["points"] and (rel.get("updated") or 0) <= tomb:
            continue
        out["relationships"].append(rel)

    #node positions are a web-only display concern: union by context key, base (server) wins on conflict,
    #and drop entries for contexts that no longer exist
    layout = {**incoming.get("layout", {}), **base.get("layout", {})}
    out["layout"] = {k: v for k, v in layout.items() if k in out["contexts"]}

    #reading progress is the device's "where i'm up to": the incoming (device) value wins when present,
    #otherwise keep what we had so a web-side merge doesn't wipe it
    inc_rp = incoming.get("reading_progress")
    out["reading_progress"] = inc_rp if inc_rp is not None else base.get("reading_progress")

    out["book"] = _merge_book(base["book"], incoming["book"])
    out["updated"] = max(base.get("updated") or 0, incoming.get("updated") or 0)
    return out
