import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Graph from "./Graph";
import Browse from "./Browse";
import Timeline from "./Timeline";
import DetailPanel from "./DetailPanel";
import { btn } from "./ui";
import { loadTypeColors, saveTypeColors } from "./typeColors";
import { downloadJson, readJsonFile, slug } from "./files";
import * as dq from "./docops";
import type { GraphPrefs } from "./theme";
import type { Doc, GraphEditOps, Selected } from "./types";

export default function BookView({ bookId, onBack, graph, onGraphChange }: {
  bookId: string; onBack: () => void; graph: GraphPrefs; onGraphChange: (g: GraphPrefs) => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tab, setTab] = useState<"graph" | "browse">("graph");
  const [scrub, setScrub] = useState(1); //0..1 narrative progress, 1 = show everything
  const [selected, setSelected] = useState<Selected>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [typeColors, setTypeColors] = useState<Record<string, string>>(loadTypeColors);
  const [undoStack, setUndoStack] = useState<Doc[]>([]);
  const [redoStack, setRedoStack] = useState<Doc[]>([]);
  const lastUpdated = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    const d = await api<Doc>("/api/books/" + encodeURIComponent(bookId));
    lastUpdated.current = d.updated;
    setDoc(d);
  }, [bookId]);

  useEffect(() => { void reload().catch(() => {}); }, [reload]);

  //poll so edits synced from the device show up without a refresh (re-render only when changed)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const d = await api<Doc>("/api/books/" + encodeURIComponent(bookId));
        if (d.updated !== lastUpdated.current) { lastUpdated.current = d.updated; setDoc(d); }
      } catch { /* ignore transient errors */ }
    }, 4000);
    return () => clearInterval(t);
  }, [bookId]);

  //keyboard undo/redo (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); void undo(); }
      else if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); void redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  //snapshot the current doc onto the undo stack (and clear the redo branch) before a mutation
  function pushHistory(before: Doc | null) {
    if (!before) return;
    setUndoStack((s) => [...s, before].slice(-60));
    setRedoStack([]);
  }
  //web-authoritative replace (used by undo/redo + node-position saves), sets the doc exactly
  async function applyReplace(next: Doc) {
    const saved = await api<Doc>("/api/books/" + encodeURIComponent(bookId), { method: "PUT", body: JSON.stringify(next) });
    lastUpdated.current = saved.updated;
    setDoc(saved);
  }
  //run a mutating endpoint, recording history so it can be undone
  async function edit(fn: () => Promise<void>) {
    const before = doc;
    await fn();
    await reload();
    pushHistory(before);
  }

  //new contexts/points are anchored to where the timeline is scrubbed to right now, so they show up at
  //that spot in the story (matching how the device anchors to the reading position)
  async function addContext(title: string, type: string) {
    await edit(() => api(`/api/books/${encodeURIComponent(bookId)}/contexts`, {
      method: "POST", body: JSON.stringify({ title, type, progress: scrub }),
    }).then(() => {}));
  }
  async function addPoint(key: string, text: string) {
    await edit(() => api(`/api/books/${encodeURIComponent(bookId)}/contexts/${encodeURIComponent(key)}/points`, {
      method: "POST", body: JSON.stringify({ text, progress: scrub }),
    }).then(() => {}));
  }
  async function editPoint(key: string, ref: { id?: string; index: number }, text: string) {
    await edit(() => api(`/api/books/${encodeURIComponent(bookId)}/contexts/${encodeURIComponent(key)}/points`, {
      method: "PATCH", body: JSON.stringify({ text, id: ref.id, index: ref.index }),
    }).then(() => {}));
  }
  //persist node positions from the graph. a user move/reset (record=true) goes on the undo stack, the
  //auto-save after an initial arrange (record=false) just persists so reopening resumes the layout.
  async function commitPositions(positions: Record<string, { x: number; y: number }>, record: boolean) {
    if (!doc) return;
    if (record) pushHistory(doc);
    await applyReplace({ ...doc, layout: { ...(doc.layout || {}), ...positions } });
  }
  //apply a client-side doc edit (clone -> mutate -> web-authoritative PUT), recorded for undo. these
  //transforms live in docops.ts and mirror the device's tombstone discipline so deletes/renames survive
  //the sync merge. returns the cloned doc so callers can read the result (e.g. a rename's new key).
  function mutate(fn: (d: Doc) => void): Doc | null {
    if (!doc) return null;
    const next = structuredClone(doc) as Doc;
    fn(next);
    pushHistory(doc);
    void applyReplace(next);
    return next;
  }

  const ops: GraphEditOps = {
    renameContext: (key, title) => {
      if (!doc) return;
      const next = structuredClone(doc) as Doc;
      const newKey = dq.renameContext(next, key, title);
      pushHistory(doc);
      void applyReplace(next);
      if (newKey !== key) setSelected({ kind: "context", id: newKey });
    },
    deleteContext: (key) => { mutate((d) => dq.deleteContext(d, key)); setSelected(null); },
    setType: (key, type) => { mutate((d) => dq.setType(d, key, type)); },
    deletePoint: (key, ref) => { mutate((d) => dq.deletePoint(d, key, ref)); },
    createLink: (from, to, label, directed) => { mutate((d) => dq.createLink(d, from, to, label, directed)); },
    editLinkLabel: (id, label) => { mutate((d) => dq.editLinkLabel(d, id, label)); },
    setLinkDirection: (id, from, to, directed) => { mutate((d) => dq.setLinkDirection(d, id, from, to, directed)); },
    deleteLink: (id) => { mutate((d) => dq.deleteLink(d, id)); setSelected(null); },
    addRelPoint: (id, text) => { mutate((d) => dq.addRelPoint(d, id, text)); },
    editRelPoint: (id, ref, text) => { mutate((d) => dq.editRelPoint(d, id, ref, text)); },
    deleteRelPoint: (id, ref) => { mutate((d) => dq.deleteRelPoint(d, id, ref)); },
  };

  async function undo() {
    if (!undoStack.length || !doc) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, doc]);
    await applyReplace(prev);
  }
  async function redo() {
    if (!redoStack.length || !doc) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, doc]);
    await applyReplace(next);
  }

  function toggleType(t: string) {
    setHiddenTypes((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }
  function exportBook() {
    if (doc) downloadJson(`${slug(doc.book?.title || bookId)}-contexts.json`, doc);
  }
  async function importBook(file: File) {
    try {
      const data = await readJsonFile(file);
      await edit(() => api(`/api/books/${encodeURIComponent(bookId)}/import`, { method: "POST", body: JSON.stringify(data) }).then(() => {}));
    } catch (e) { alert("Import failed: " + (e as Error).message); }
  }
  function setTypeColor(t: string, color: string | null) {
    setTypeColors((prev) => {
      const n = { ...prev };
      if (color) n[t] = color; else delete n[t]; //null = reset to default
      saveTypeColors(n);
      return n;
    });
  }

  if (!doc) return <div className="h-full grid place-items-center text-ink-faint">Loading…</div>;

  const n = Object.keys(doc.contexts || {}).length;
  const rels = (doc.relationships || []).length;

  return (
    <div className="h-full flex flex-col px-5 py-4 gap-3">
      {/* title row + view toggle */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <button className={btn} onClick={onBack}>← Books</button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-tight truncate">{doc.book?.title || bookId}</h2>
          <p className="text-xs text-ink-faint">
            {n} context{n === 1 ? "" : "s"} · {rels} link{rels === 1 ? "" : "s"}
            {doc.book?.authors ? ` · ${doc.book.authors}` : ""}
          </p>
        </div>
        <span className="flex-1" />
        <button className={btn} onClick={undo} disabled={!undoStack.length} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">↶</button>
        <button className={btn} onClick={redo} disabled={!redoStack.length} title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo">↷</button>
        <button className={btn} onClick={exportBook} title="Download this book's contexts">Export</button>
        <label className={`${btn} cursor-pointer`} title="Merge a contexts file into this book">
          Import
          <input type="file" accept=".json,application/json" className="hidden"
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importBook(f); }} />
        </label>
        <div className="flex p-0.5 rounded-lg border border-line bg-paper-sunk">
          {(["graph", "browse"] as const).map((v) => (
            <button key={v} onClick={() => setTab(v)}
                    className={`px-3 py-1 rounded-md text-sm font-medium capitalize transition ${
                      tab === v ? "bg-paper-card text-ink shadow-card" : "text-ink-soft hover:text-ink"}`}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0">
        <Timeline doc={doc} scrub={scrub} onScrub={setScrub} />
      </div>

      {/* main work area fills the rest of the viewport */}
      <div className="flex-1 min-h-0">
        {tab === "graph" ? (
          <Graph doc={doc} scrub={scrub} onScrub={setScrub} selected={selected} onSelect={setSelected}
                 hiddenTypes={hiddenTypes} onToggleType={toggleType} typeColors={typeColors} onSetTypeColor={setTypeColor}
                 onAddPoint={addPoint} onEditPoint={editPoint} onMoveNodes={commitPositions}
                 graph={graph} onGraphChange={onGraphChange} ops={ops} />
        ) : (
          <div className="h-full flex gap-3 items-start overflow-hidden">
            <div className="flex-1 min-w-0 h-full overflow-auto pr-1">
              <Browse doc={doc} scrub={scrub} selected={selected} onSelect={setSelected}
                      hiddenTypes={hiddenTypes} typeColors={typeColors} onAddContext={addContext} />
            </div>
            <div className="w-[300px] shrink-0 h-full overflow-auto">
              <DetailPanel doc={doc} selected={selected} scrub={scrub} typeColors={typeColors} onAddPoint={addPoint} onEditPoint={editPoint} onClose={() => setSelected(null)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
