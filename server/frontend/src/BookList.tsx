import { useEffect, useState } from "react";
import { api } from "./api";
import { btn, btnAccent, input } from "./ui";
import type { BookSummary } from "./types";

const byOrder = (a: BookSummary, b: BookSummary) =>
  (a.series_index ?? 0) - (b.series_index ?? 0) || (a.title || "").localeCompare(b.title || "");

export default function BookList({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);  //book_id whose series is being edited
  const [name, setName] = useState("");
  const [pos, setPos] = useState("");
  const [error, setError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ series: string; before: string | null } | null>(null);

  const load = () => api<BookSummary[]>("/api/books").then(setBooks).catch(() => setBooks([]));
  useEffect(() => {
    let alive = true;
    const tick = () => api<BookSummary[]>("/api/books").then((b) => alive && setBooks(b)).catch(() => alive && setBooks([]));
    void tick();
    const t = setInterval(tick, 5000); //pick up newly-synced books
    return () => { alive = false; clearInterval(t); };
  }, []);

  const patchMeta = (bookId: string, series: string, series_index: number) =>
    api(`/api/books/${encodeURIComponent(bookId)}/meta`, { method: "PATCH", body: JSON.stringify({ series, series_index }) });

  //the next free position in a series (one past the highest existing one)
  const nextIndex = (series: string, excludeId?: string) =>
    (books || []).filter((b) => (b.series || "") === series && b.book_id !== excludeId)
      .reduce((m, b) => Math.max(m, b.series_index ?? 0), -1) + 1;

  //save the series + (optional 1-based) position typed into the inline editor
  async function saveSeries(bookId: string) {
    setError("");
    const s = name.trim();
    const idx = pos.trim() ? Math.max(0, (parseInt(pos, 10) || 1) - 1) : nextIndex(s, bookId); //blank => next free
    try {
      await patchMeta(bookId, s, idx);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message || "couldn't save — is the server up to date?");
    }
  }

  //handle a drop. joining a new series appends at the next free number, dropping within the same
  //series reorders around `beforeId` and renumbers that series contiguously.
  async function moveBook(toSeries: string, beforeId: string | null) {
    setHint(null);
    const id = dragId; setDragId(null);
    if (!id || !books) return;
    const drag = books.find((b) => b.book_id === id);
    if (!drag) return;

    try {
      if ((drag.series || "") !== toSeries) {
        await patchMeta(id, toSeries, nextIndex(toSeries, id));
      } else {
        const ordered = books.filter((b) => (b.series || "") === toSeries && b.book_id !== id).sort(byOrder);
        let at = ordered.length;
        if (beforeId) { const i = ordered.findIndex((b) => b.book_id === beforeId); if (i >= 0) at = i; }
        ordered.splice(at, 0, drag);
        const patches = ordered
          .map((b, idx) => ({ b, idx }))
          .filter(({ b, idx }) => (b.series_index ?? 0) !== idx)
          .map(({ b, idx }) => patchMeta(b.book_id, toSeries, idx));
        if (!patches.length) return;
        await Promise.all(patches);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!books) return <p className="text-ink-faint">Loading…</p>;
  if (books.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-paper-card p-8 text-center">
        <p className="font-medium">No books synced yet</p>
        <p className="text-sm text-ink-faint mt-1">Sync from KOReader and your books will show up here.</p>
      </div>
    );
  }

  //group by series, named series first (alphabetical), unfiled books last
  const groups = new Map<string, BookSummary[]>();
  for (const b of books) {
    const s = b.series || "";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(b);
  }
  const named = [...groups.keys()].filter((s) => s).sort((a, b) => a.localeCompare(b));
  const sections = [...named, ...(groups.has("") ? [""] : [])];

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Your books</h2>
        <span className="text-xs text-ink-faint">drag a book onto a series, or between books to reorder</span>
      </div>
      <datalist id="series-list">{named.map((s) => <option key={s} value={s} />)}</datalist>
      {error && <p className="text-red-600 text-sm mb-2">{error}</p>}

      {sections.map((series) => {
        const list = (groups.get(series) || []).slice().sort(byOrder);
        const isDropGroup = hint?.series === series && hint.before === null;
        return (
          <div key={series || "_none"} className="mb-5"
               onDragOver={(e) => { if (dragId) { e.preventDefault(); setHint({ series, before: null }); } }}
               onDrop={(e) => { e.preventDefault(); void moveBook(series, null); }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                {series || "Not in a series"}
              </span>
              <span className="text-xs text-ink-faint tabular-nums">{list.length}</span>
            </div>
            <div className={`flex flex-wrap items-start gap-2.5 rounded-xl transition ${isDropGroup ? "ring-2 ring-accent-ring/50 bg-accent-soft/40 p-1.5 -m-1.5" : ""}`}>
              {list.map((b) => {
                const dropBefore = hint?.series === series && hint.before === b.book_id;
                return (
                  <div key={b.book_id} draggable
                       onDragStart={(e) => { setDragId(b.book_id); e.dataTransfer.effectAllowed = "move"; }}
                       onDragEnd={() => { setDragId(null); setHint(null); }}
                       onDragOver={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); setHint({ series, before: b.book_id }); } }}
                       onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void moveBook(series, b.book_id); }}
                       className={`relative w-64 rounded-xl border bg-paper-card p-4 shadow-card transition cursor-grab active:cursor-grabbing hover:shadow-pop hover:border-accent-ring ${
                         dragId === b.book_id ? "opacity-40" : ""} ${dropBefore ? "border-accent" : "border-line"}`}>
                    {dropBefore && <span className="absolute -left-1.5 top-2 bottom-2 w-1 rounded-full bg-accent" />}
                    <button className="group block w-full text-left" onClick={() => onOpen(b.book_id)}>
                      <strong className="block truncate group-hover:text-accent-hover transition">{b.title || b.book_id}</strong>
                      {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
                    </button>
                    <div className="mt-2 pt-2 border-t border-line">
                      {editing === b.book_id ? (
                        <form onSubmit={(e) => { e.preventDefault(); void saveSeries(b.book_id); }}>
                          <div className="flex gap-1.5 items-center">
                            <input autoFocus list="series-list" className={`${input} flex-1 py-1 min-w-0`} placeholder="series name" value={name}
                                   onChange={(e) => setName(e.target.value)}
                                   onKeyDown={(e) => { if (e.key === "Escape") { setEditing(null); setError(""); } }} />
                            <input type="number" min={1} className={`${input} w-14 py-1`} placeholder="#" value={pos}
                                   onChange={(e) => setPos(e.target.value)} />
                          </div>
                          <div className="flex gap-1.5 mt-1.5">
                            <button type="submit" className={`${btnAccent} py-1`}>Save</button>
                            <button type="button" className={`${btn} py-1`} onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
                          </div>
                        </form>
                      ) : (
                        <button className="text-xs text-ink-soft hover:text-accent-hover transition"
                                onClick={() => { setEditing(b.book_id); setName(b.series || ""); setPos(b.series ? String((b.series_index ?? 0) + 1) : ""); setError(""); }}>
                          {b.series ? `${b.series} · #${(b.series_index ?? 0) + 1}` : "+ Add to a series"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {list.length === 0 && <div className="text-sm text-ink-faint px-1 py-3">drop a book here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
