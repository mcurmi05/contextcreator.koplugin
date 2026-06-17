import { useEffect, useState } from "react";
import { api } from "./api";
import { readJsonFile } from "./files";
import { loadProfile, saveProfile } from "./profilePref";
import { btn, btnAccent, input } from "./ui";
import type { BookSummary, LibraryEntry } from "./types";

//the profile a card will open at: the remembered choice if it still exists, else the first profile
function chosenProfile(b: BookSummary, override?: string): string {
  const list = b.profiles || [];
  const want = override ?? loadProfile(b.book_id);
  if (list.some((p) => p.profile_id === want)) return want;
  return list[0]?.profile_id || "default";
}

const byOrder = (a: BookSummary, b: BookSummary) =>
  (a.series_index ?? 0) - (b.series_index ?? 0) || (a.title || "").localeCompare(b.title || "");

const isExternal = (b: BookSummary) => b.source === "external";

export default function BookList({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libOpen, setLibOpen] = useState(false);
  const [attachFor, setAttachFor] = useState<string | null>(null); //external book_id being attached
  const [editing, setEditing] = useState<string | null>(null);  //book_id whose series is being edited
  const [name, setName] = useState("");
  const [pos, setPos] = useState("");
  const [error, setError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ series: string; before: string | null } | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({}); //book_id -> profile_id to open at

  //open a book at the chosen profile (remembering it so BookView lands there)
  function open(b: BookSummary) {
    const pid = chosenProfile(b, picked[b.book_id]);
    saveProfile(b.book_id, pid);
    onOpen(b.book_id);
  }
  function pickProfile(bookId: string, pid: string) {
    setPicked((m) => ({ ...m, [bookId]: pid }));
    saveProfile(bookId, pid);
  }

  const load = async () => {
    try { setBooks(await api<BookSummary[]>("/api/books")); } catch { setBooks([]); }
    try { setLibrary(await api<LibraryEntry[]>("/api/library")); } catch { /* ignore */ }
  };
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const b = await api<BookSummary[]>("/api/books"); if (alive) setBooks(b); } catch { if (alive) setBooks((p) => p ?? []); }
      try { const l = await api<LibraryEntry[]>("/api/library"); if (alive) setLibrary(l); } catch { /* ignore */ }
    };
    void tick();
    const t = setInterval(tick, 5000); //pick up newly-synced books + library updates
    return () => { alive = false; clearInterval(t); };
  }, []);

  const patchMeta = (bookId: string, series: string, series_index: number) =>
    api(`/api/books/${encodeURIComponent(bookId)}/meta`, { method: "PATCH", body: JSON.stringify({ series, series_index }) });

  //the next free position in a series (one past the highest existing one), device books only
  const nextIndex = (series: string, excludeId?: string) =>
    (books || []).filter((b) => !isExternal(b) && (b.series || "") === series && b.book_id !== excludeId)
      .reduce((m, b) => Math.max(m, b.series_index ?? 0), -1) + 1;

  async function saveSeries(bookId: string) {
    setError("");
    const s = name.trim();
    const idx = pos.trim() ? Math.max(0, (parseInt(pos, 10) || 1) - 1) : nextIndex(s, bookId);
    try { await patchMeta(bookId, s, idx); setEditing(null); await load(); }
    catch (e) { setError((e as Error).message || "couldn't save — is the server up to date?"); }
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
        const ordered = books.filter((b) => !isExternal(b) && (b.series || "") === toSeries && b.book_id !== id).sort(byOrder);
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
    } catch (e) { setError((e as Error).message); }
  }

  //adopt a device-library book (no notes yet): server makes a doc for it, then we open it
  async function adopt(bookId: string) {
    setError("");
    try { await api(`/api/library/${encodeURIComponent(bookId)}/adopt`, { method: "POST" }); await load(); onOpen(bookId); }
    catch (e) { setError((e as Error).message); }
  }

  //import a standalone contexts file as a web-only "Imported" book
  async function importExternal(file: File) {
    setError("");
    try { await api("/api/external", { method: "POST", body: JSON.stringify(await readJsonFile(file)) }); await load(); }
    catch (e) { setError("Import failed: " + (e as Error).message); }
  }

  //attach one profile of an imported doc to a real book as a NEW named profile, then it's gone from Imported
  async function attach(externalId: string, targetId: string, fromProfile: string, name: string) {
    setError("");
    try {
      const r = await api<{ profile_id: string }>(
        `/api/books/${encodeURIComponent(targetId)}/attach/${encodeURIComponent(externalId)}` +
        `?from_profile=${encodeURIComponent(fromProfile)}&name=${encodeURIComponent(name)}`, { method: "POST" });
      saveProfile(targetId, r.profile_id); //so opening that book lands on the freshly attached profile
      setAttachFor(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  //a per-book profile chooser, shown when a book has more than one. picking it sets where the card opens
  //(and, for an Imported entry, which profile gets attached).
  const profileDropdown = (b: BookSummary) => (
    <select className={`${input} w-full py-1 text-sm`} value={chosenProfile(b, picked[b.book_id])}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
            onChange={(e) => pickProfile(b.book_id, e.target.value)}>
      {(b.profiles || []).map((p) => <option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}
    </select>
  );

  if (!books) return <p className="text-ink-faint">Loading…</p>;

  const deviceBooks = books.filter((b) => !isExternal(b));
  const externalBooks = books.filter(isExternal);

  //group device books by series, named series first (alphabetical), unfiled books last
  const groups = new Map<string, BookSummary[]>();
  for (const b of deviceBooks) {
    const s = b.series || "";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(b);
  }
  const named = [...groups.keys()].filter((s) => s).sort((a, b) => a.localeCompare(b));
  const sections = [...named, ...(groups.has("") ? [""] : [])];

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Your books</h2>
        <span className="text-xs text-ink-faint">drag a book onto a series, or between books to reorder</span>
      </div>
      <datalist id="series-list">{named.map((s) => <option key={s} value={s} />)}</datalist>

      {/* books on the device that don't have contexts yet — start one from here */}
      {library.length > 0 && (
        <div className="mb-5 rounded-xl border border-line bg-paper-card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-paper-sunk transition"
                  onClick={() => setLibOpen((v) => !v)}>
            <span className="text-sm font-medium">Other books on your device</span>
            <span className="text-xs text-ink-faint tabular-nums">{library.length}</span>
            <span className="flex-1" />
            <span className="text-ink-faint text-xs">{libOpen ? "▾" : "▸"} no notes yet</span>
          </button>
          {libOpen && (
            <div className="px-3 pb-3 pt-1 flex flex-wrap gap-2">
              {library.map((e) => (
                <button key={e.book_id} onClick={() => adopt(e.book_id)}
                        className="w-56 text-left rounded-lg border border-line px-3 py-2 hover:border-accent-ring hover:shadow-card transition">
                  <strong className="block truncate text-sm">{e.title || e.book_id}</strong>
                  {e.authors && <span className="block text-xs text-ink-faint truncate">{e.authors}</span>}
                  <span className="block text-[11px] text-accent-hover mt-1">+ start contexts</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {deviceBooks.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper-card p-6 text-center mb-5">
          <p className="font-medium">No books with contexts yet</p>
          <p className="text-sm text-ink-faint mt-1">Take notes in KOReader, or start one from a device book above.</p>
        </div>
      )}

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
                    <button className="group block w-full text-left" onClick={() => open(b)}>
                      <strong className="block truncate group-hover:text-accent-hover transition">{b.title || b.book_id}</strong>
                      {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
                    </button>
                    {(b.profiles?.length ?? 0) >= 1 && (
                      <label className="mt-2 block">
                        <span className="block text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Profile</span>
                        {profileDropdown(b)}
                      </label>
                    )}
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

      {/* standalone imported context files (web-only, e.g. shared by other users) */}
      <div className="mt-8 pt-5 border-t border-line">
        <div className="flex items-baseline gap-2 mb-2 flex-wrap">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Imported</h2>
          <span className="text-xs text-ink-faint">standalone context files, viewed only on the web</span>
          <span className="flex-1" />
          <label className={`${btn} cursor-pointer`}>
            Import JSON
            <input type="file" accept=".json,application/json" className="hidden"
                   onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importExternal(f); }} />
          </label>
        </div>
        {externalBooks.length === 0 ? (
          <p className="text-sm text-ink-faint">Import a contexts file someone shared to browse it here. You can attach it to one of your books later.</p>
        ) : (
          <div className="flex flex-wrap items-start gap-2.5">
            {externalBooks.map((b) => (
              <div key={b.book_id} className="w-64 rounded-xl border border-line bg-paper-card p-4 shadow-card">
                <button className="group block w-full text-left" onClick={() => open(b)}>
                  <strong className="block truncate group-hover:text-accent-hover transition">{b.title || "Imported contexts"}</strong>
                  {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
                </button>
                {(b.profiles?.length ?? 0) >= 1 && (
                  <label className="mt-2 block">
                    <span className="block text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Profile</span>
                    {profileDropdown(b)}
                  </label>
                )}
                <div className="mt-2 pt-2 border-t border-line">
                  {attachFor === b.book_id ? (
                    <div className="flex gap-1.5 items-center">
                      <select autoFocus className={`${input} flex-1 py-1 min-w-0`} defaultValue=""
                              onChange={(e) => {
                                const targetId = e.target.value;
                                if (!targetId) return;
                                const def = b.title || "Imported";
                                const nm = window.prompt("Name the new profile this becomes on that book:", def);
                                if (nm && nm.trim()) void attach(b.book_id, targetId, chosenProfile(b, picked[b.book_id]), nm.trim());
                                else setAttachFor(null);
                              }}>
                        <option value="" disabled>attach to…</option>
                        {deviceBooks.map((d) => <option key={d.book_id} value={d.book_id}>{d.title || d.book_id}</option>)}
                      </select>
                      <button className={`${btn} py-1`} onClick={() => setAttachFor(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="text-xs text-ink-soft hover:text-accent-hover transition disabled:opacity-50"
                            disabled={deviceBooks.length === 0} title={deviceBooks.length === 0 ? "no books to attach to yet" : undefined}
                            onClick={() => setAttachFor(b.book_id)}>
                      + Attach to one of your books
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
