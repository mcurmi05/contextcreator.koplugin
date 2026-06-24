"""
backward-compatibility guard: documents/exports written by older app versions must still load, migrate
and merge on the current server without losing data. run directly (`python tests/test_backcompat.py`)
or under pytest. these exercise the pure migration/merge code, so they need no database.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # put server/ on the path

from app.services.sync import SCHEMA_VERSION, _normalize, merge, new_doc  # noqa: E402


def test_legacy_v1_doc_normalizes():
    #a v1 doc: bare-string + id-less points, empty points serialized as {} (object, not []), a relationship
    #with no `directed`, and missing layout/tombstones/reading_progress/updated.
    legacy = {
        "schema": 1,
        "book": {"id": "b1", "title": "Old Book"},
        "contexts": {
            "jon": {"title": "Jon", "type": "character",
                    "points": ["a bare string point", {"text": "id-less point"}]},
            "ned": {"title": "Ned", "points": {}},
        },
        "relationships": [{"id": "r1", "from": "jon", "to": "ned", "label": "son of"}],
    }
    n = _normalize(legacy)
    assert n["schema"] == SCHEMA_VERSION                                   # upgraded
    assert set(n["tombstones"]) == {"contexts", "relationships", "points"}  # missing tombstones filled
    assert n["layout"] == {} and n["reading_progress"] is None             # missing fields filled
    assert set(n["contexts"]) == {"jon", "ned"}                            # nothing dropped


def test_legacy_v1_doc_merges_without_loss():
    #merging a legacy doc into a fresh one is what import/store effectively does — no point should vanish.
    legacy = {
        "schema": 1,
        "contexts": {"jon": {"title": "Jon",
                             "points": ["a bare string point", {"text": "id-less point"}]}},
        "relationships": [{"id": "r1", "from": "jon", "to": "jon", "label": "self"}],
    }
    merged = merge(new_doc(), legacy)
    texts = sorted(p.get("text") if isinstance(p, dict) else str(p)
                   for p in merged["contexts"]["jon"]["points"])
    assert "a bare string point" in texts        # legacy bare-string point kept
    assert "id-less point" in texts              # id-less point kept
    assert any(r["id"] == "r1" for r in merged["relationships"])


def test_legacy_point_does_not_duplicate_idd_one():
    #a bare-string point that matches the text of an already-id'd point is the same point from before it
    #had an id — it must fold in, not duplicate.
    base = new_doc()
    base["contexts"]["jon"] = {"title": "Jon", "points": [{"id": "p1", "text": "hello", "updated": 1}], "updated": 1}
    merged = merge(base, {"contexts": {"jon": {"title": "Jon", "points": ["hello"], "updated": 1}}})
    hellos = [p for p in merged["contexts"]["jon"]["points"]
              if (p.get("text") if isinstance(p, dict) else p) == "hello"]
    assert len(hellos) == 1


def test_newer_schema_is_preserved():
    #a doc written by a NEWER app keeps its higher version and its unknown fields, so a mixed fleet never
    #silently downgrades each other.
    n = _normalize({"schema": 99, "contexts": {}, "futureField": {"x": 1}})
    assert n["schema"] == 99
    assert n.get("futureField") == {"x": 1}


def test_empty_and_missing_doc():
    #a totally empty / missing doc still yields a well-shaped doc.
    for d in (None, {}, {"schema": 2}):
        n = _normalize(d)
        assert n["contexts"] == {} and n["relationships"] == [] and n["schema"] >= 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok -", fn.__name__)
    print(f"\nALL {len(fns)} BACKWARD-COMPAT CHECKS PASSED")
