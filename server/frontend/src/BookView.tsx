import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Graph from "./Graph";
import Browse from "./Browse";
import Timeline from "./Timeline";
import DetailPanel from "./DetailPanel";
import { btn } from "./ui";
import { loadTypeColors, saveTypeColors } from "./typeColors";
import type { Doc, Selected } from "./types";

export default function BookView({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tab, setTab] = useState<"graph" | "browse">("graph");
  const [scrub, setScrub] = useState(1); //0..1 narrative progress; 1 = show everything
  const [selected, setSelected] = useState<Selected>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [typeColors, setTypeColors] = useState<Record<string, string>>(loadTypeColors);
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

  async function addContext(title: string, type: string) {
    await api(`/api/books/${encodeURIComponent(bookId)}/contexts`, {
      method: "POST", body: JSON.stringify({ title, type }),
    });
    await reload();
  }
  async function addPoint(key: string, text: string) {
    await api(`/api/books/${encodeURIComponent(bookId)}/contexts/${encodeURIComponent(key)}/points`, {
      method: "POST", body: JSON.stringify({ text }),
    });
    await reload();
  }
  async function editPoint(key: string, ref: { id?: string; index: number }, text: string) {
    await api(`/api/books/${encodeURIComponent(bookId)}/contexts/${encodeURIComponent(key)}/points`, {
      method: "PATCH", body: JSON.stringify({ text, id: ref.id, index: ref.index }),
    });
    await reload();
  }
  function toggleType(t: string) {
    setHiddenTypes((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
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
          <Graph doc={doc} scrub={scrub} selected={selected} onSelect={setSelected}
                 hiddenTypes={hiddenTypes} onToggleType={toggleType} typeColors={typeColors} onSetTypeColor={setTypeColor}
                 onAddPoint={addPoint} onEditPoint={editPoint} />
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
