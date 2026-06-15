import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Graph from "./Graph";
import Browse from "./Browse";
import Timeline from "./Timeline";
import DetailPanel from "./DetailPanel";
import { btn, btnActive } from "./ui";
import type { Doc, Selected } from "./types";

export default function BookView({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tab, setTab] = useState<"graph" | "browse">("graph");
  const [scrub, setScrub] = useState(1); //0..1 narrative progress; 1 = show everything
  const [selected, setSelected] = useState<Selected>(null);
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

  if (!doc) return <p className="text-gray-500">Loading…</p>;
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap">
        <button className={btn} onClick={onBack}>← Books</button>
        <h2 className="text-xl font-semibold m-0">{doc.book?.title || bookId}</h2>
      </div>

      <Timeline doc={doc} scrub={scrub} onScrub={setScrub} />

      <div className="flex gap-2 my-3">
        <button className={tab === "graph" ? btnActive : btn} onClick={() => setTab("graph")}>Graph</button>
        <button className={tab === "browse" ? btnActive : btn} onClick={() => setTab("browse")}>Browse</button>
      </div>

      <div className="flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          {tab === "graph"
            ? <Graph doc={doc} scrub={scrub} selected={selected} onSelect={setSelected} />
            : <Browse doc={doc} scrub={scrub} selected={selected} onSelect={setSelected} onAddContext={addContext} />}
        </div>
        <DetailPanel doc={doc} selected={selected} scrub={scrub} onAddPoint={addPoint} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}
