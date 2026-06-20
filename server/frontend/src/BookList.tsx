import { useEffect, useState } from "react";
import { api } from "./api";
import { readJsonFile } from "./files";
import { loadProfile, saveProfile } from "./profilePref";
import { btn, input } from "./ui";
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

//small cover thumbnail; covers are data: urls synced from the device. renders nothing when absent
//(e.g. imported docs, or books whose cover the device hasn't extracted yet), leaving the card unchanged.
function Cover({ src, title }: { src?: string; title?: string }) {
  if (!src) return null;
  return (
    <img src={src} alt={title ? `${title} cover` : "cover"} loading="lazy"
         className="w-10 h-14 shrink-0 rounded object-cover border border-line bg-paper-sunk" />
  );
}

export default function BookList({ onOpen, showUnstarted = true }: { onOpen: (bookId: string) => void; showUnstarted?: boolean }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [attachFor, setAttachFor] = useState<string | null>(null); //external book_id being attached
  const [error, setError] = useState("");
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

  const externalBooks = books.filter(isExternal);

  //one grid for every device book: those with contexts (real Book rows) plus the device's other books from
  //the read-history catalog (no notes yet, shown dimmed with "start contexts", hidden when the user turns
  //them off in settings). series grouping is read-only here — it comes from each book's koreader metadata,
  //so it's changed in koreader, not on the web. library entries already exclude anything that has a Book
  //row, so there are no duplicates.
  type DeviceCard = BookSummary & { started: boolean };
  const startedBooks: DeviceCard[] = books.filter((b) => !isExternal(b)).map((b) => ({ ...b, started: true }));
  const libraryCards: DeviceCard[] = showUnstarted
    ? library.map((e) => ({ book_id: e.book_id, title: e.title, authors: e.authors, cover: e.cover, series: e.series || "", series_index: e.series_index ?? 0, started: false }))
    : [];
  const deviceBooks: DeviceCard[] = [...startedBooks, ...libraryCards];

  //group by series, named series first (alphabetical), the unfiled bucket (incl. all un-started books) last
  const groups = new Map<string, DeviceCard[]>();
  for (const b of deviceBooks) {
    const s = b.series || "";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(b);
  }
  //within a group, started (annotated) books first, then the "start contexts" ones
  const cardOrder = (a: DeviceCard, b: DeviceCard) => Number(b.started) - Number(a.started) || byOrder(a, b);
  const named = [...groups.keys()].filter((s) => s).sort((a, b) => a.localeCompare(b));
  const sections = [...named, ...(groups.has("") ? [""] : [])];

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Your books</h2>
      </div>

      {deviceBooks.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper-card p-6 text-center mb-5">
          <p className="font-medium">No books yet</p>
          <p className="text-sm text-ink-faint mt-1">Open a book in KOReader and sync — your library shows up here, ready to annotate.</p>
        </div>
      )}

      {sections.map((series) => {
        const list = (groups.get(series) || []).slice().sort(cardOrder);
        return (
          <div key={series || "_none"} className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                {series || "Not in a series"}
              </span>
              <span className="text-xs text-ink-faint tabular-nums">{list.length}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 items-start gap-2.5">
              {list.map((b) => (
                <div key={b.book_id}
                     className={`relative w-full rounded-xl border border-line bg-paper-card p-3 shadow-card transition hover:shadow-pop hover:border-accent-ring cursor-pointer ${
                       b.started ? "" : "opacity-65 hover:opacity-100"}`}>
                  <button className="group flex w-full items-start gap-2.5 text-left"
                          onClick={() => (b.started ? open(b) : adopt(b.book_id))}>
                    <Cover src={b.cover} title={b.title} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate group-hover:text-accent-hover transition">{b.title || b.book_id}</strong>
                      {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
                    </span>
                  </button>
                  {b.started ? (
                    <>
                      {(b.profiles?.length ?? 0) >= 1 && (
                        <label className="mt-2 block">
                          <span className="block text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Profile</span>
                          {profileDropdown(b)}
                        </label>
                      )}
                      {b.series && (
                        <div className="mt-2 pt-2 border-t border-line">
                          <span className="block text-xs text-ink-soft">{b.series} · #{(b.series_index ?? 0) + 1}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="mt-2 pt-2 border-t border-line">
                      <button className="text-xs font-medium text-accent-hover hover:underline transition"
                              onClick={() => adopt(b.book_id)}>+ start contexts</button>
                      {b.series && <span className="block text-xs text-ink-soft mt-1">{b.series} · #{(b.series_index ?? 0) + 1}</span>}
                    </div>
                  )}
                </div>
              ))}
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
                <button className="group flex w-full items-start gap-2.5 text-left" onClick={() => open(b)}>
                  <Cover src={b.cover} title={b.title} />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate group-hover:text-accent-hover transition">{b.title || "Imported contexts"}</strong>
                    {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
                  </span>
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
