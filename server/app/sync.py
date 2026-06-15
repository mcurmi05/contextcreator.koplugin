#the additive merge at the heart of sync. given two versions of a book's document, produce one that
#loses nothing: union contexts (by key), relationships (by id) and dot points (by id), minus anything
#tombstoned. it's purely additive, so genuine conflicts duplicate rather than clobber:
#the device mints a NEW point id whenever a point's text is edited (tombstoning the old id), so two
#devices editing "the same" point independently end up with two points after merge, and the user
#deletes the loser later. scalar labels (title/type/label/direction) fall back to newest `updated`
#since those aren't content. a tombstoned context/relationship is dropped only if nothing live
#remains under it (a concurrent point added elsewhere keeps it alive). re-merging is idempotent.

EMPTY_TOMBSTONES = ("contexts", "relationships", "points")


def _normalize(doc):
    #be defensive about types: a client serializing an EMPTY array can send {} (a JSON object) instead
    #of [], so coerce each field to the shape the merge expects rather than trusting the input.
    doc = dict(doc or {})
    doc["schema"] = doc.get("schema") or 3
    doc["book"] = doc["book"] if isinstance(doc.get("book"), dict) else {}
    doc["updated"] = doc.get("updated") or 0
    doc["contexts"] = doc["contexts"] if isinstance(doc.get("contexts"), dict) else {}
    doc["relationships"] = doc["relationships"] if isinstance(doc.get("relationships"), list) else []
    t = doc.get("tombstones") if isinstance(doc.get("tombstones"), dict) else {}
    t = dict(t)
    for k in EMPTY_TOMBSTONES:
        t[k] = t[k] if isinstance(t.get(k), dict) else {}
    doc["tombstones"] = t
    return doc


def new_doc():
    return {
        "schema": 3,
        "book": {},
        "updated": 0,
        "contexts": {},
        "relationships": [],
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
        by_id.setdefault(pid, p)  #first occurrence wins; same id => same content (edits churn ids)
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
    for field in ("id", "title", "authors"):
        book[field] = b.get(field) or a.get(field)
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

    out["book"] = _merge_book(base["book"], incoming["book"])
    out["updated"] = max(base.get("updated") or 0, incoming.get("updated") or 0)
    return out
