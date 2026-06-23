import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { readJsonFile } from "./files";
import { loadProfile, saveProfile } from "./profilePref";
import {
  DEFAULT_PREFS, fetchHomePrefs, saveHomePrefs, applyManualOrder,
  pinsFor, withOrder, withPins, type HomePrefs, type HomeSort, type AuthorSort,
} from "./homePrefs";
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

//sort key for an author by last name: take the first listed author (authors may be newline/&/"and"
//separated), then its final whitespace token, handling the "Last, First" form by using the part before
//the comma. used for the default home page author sort; first-name sort just uses the whole string.
function lastNameKey(authors: string): string {
  const first = (authors || "").split(/[\n;&]| and /i)[0].trim();
  if (!first) return "";
  if (first.includes(",")) return first.slice(0, first.indexOf(",")).trim().toLowerCase();
  const parts = first.split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

//how long a reordered item takes to slide to its new spot, and the matching minimum gap between
//reorders. kept slow + equal so each shift fully plays out and the user can follow what moved.
const SLIDE_MS = 320;

//FLIP animation: when the rendered order (orderKey) changes, slide each item from where it just was to
//where it now is, so items reflow smoothly around the one being dragged. returns a ref callback to tag
//each animatable element by id.
function useFlip(orderKey: string) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prev = useRef(new Map<string, DOMRect>());
  const cbs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  //stable ref callback per id, so React doesn't churn (null then set) the node map on every render
  const register = useCallback((id: string) => {
    let cb = cbs.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => { if (el) nodes.current.set(id, el); else nodes.current.delete(id); };
      cbs.current.set(id, cb);
    }
    return cb;
  }, []);
  useLayoutEffect(() => {
    const cur = new Map<string, DOMRect>();
    nodes.current.forEach((el, id) => cur.set(id, el.getBoundingClientRect()));
    cur.forEach((rect, id) => {
      const p = prev.current.get(id);
      const el = nodes.current.get(id);
      if (!p || !el) return;
      const dx = p.left - rect.left, dy = p.top - rect.top;
      if (dx || dy) {
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          el.style.transform = "";
        });
      }
    });
    prev.current = cur;
  }, [orderKey]);
  return register;
}

//small cover thumbnail. covers are data: urls synced from the device; until one comes through (imported
//docs, or a book the device hasnt extracted yet) we show the bundled placeholder instead of a gap, and
//fall back to it too if a stored cover fails to decode. the error state is tracked in react (not by
//mutating the img src) and is reset whenever src changes, so a cover that arrives on a later poll always
//wins, the desync you get from imperatively reassigning img.src would otherwise pin it to the placeholder.
const PLACEHOLDER_COVER = "/placeholder.jpg";
function Cover({ src, title }: { src?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]); //a freshly synced cover gets another chance to load
  const showPlaceholder = !src || failed;
  return (
    <img src={showPlaceholder ? PLACEHOLDER_COVER : src} alt={title ? `${title} cover` : "cover"} loading="lazy"
         onError={() => { if (src && !failed) setFailed(true); }}
         className="w-10 h-14 shrink-0 rounded object-cover border border-line bg-paper-sunk" />
  );
}

export default function BookList({ onOpen, showUnstarted = true, showProgress = true }: { onOpen: (bookId: string) => void; showUnstarted?: boolean; showProgress?: boolean }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [attachFor, setAttachFor] = useState<string | null>(null); //external book_id being attached
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({}); //book_id -> profile_id to open at
  const [prefs, setPrefs] = useState<HomePrefs>(DEFAULT_PREFS); //home layout (sort/group/order/pins), server-stored
  const [dragId, setDragId] = useState<string | null>(null);       //unit being dragged in manual mode
  const [preview, setPreview] = useState<string[] | null>(null);   //live reordered ids while dragging
  const [editMeta, setEditMeta] = useState<string | null>(null);   //book_id whose series is being edited
  const [seriesDraft, setSeriesDraft] = useState("");
  const [idxDraft, setIdxDraft] = useState("");                     //1-based position as the user sees it
  const [resetOpen, setResetOpen] = useState(false);               //whether the "reset order" menu is open
  const resetRef = useRef<HTMLDivElement>(null);
  const [dragHandle, setDragHandle] = useState<string | null>(null); //series whose grip is held (handle-only drag)

  useEffect(() => { void fetchHomePrefs().then(setPrefs); }, []);
  //close the reset-order menu when clicking anywhere outside it
  useEffect(() => {
    if (!resetOpen) return;
    const onDoc = (e: MouseEvent) => { if (resetRef.current && !resetRef.current.contains(e.target as Node)) setResetOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [resetOpen]);
  //change prefs optimistically and persist to the server
  const update = (next: HomePrefs) => { setPrefs(next); saveHomePrefs(next); };
  const grouped = prefs.group;
  const sort = prefs.sort;

  function togglePin(id: string) {
    const pins = pinsFor(prefs, grouped);
    update(withPins(prefs, grouped, pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id]));
  }

  //manually fix a book's series name / position when koreader's metadata is wrong (idxDraft is 1-based)
  function startEditMeta(b: BookSummary) {
    setEditMeta(b.book_id);
    setSeriesDraft(b.series || "");
    setIdxDraft(String((b.series_index ?? 0) + 1));
  }
  async function saveMeta(bookId: string) {
    const n = parseInt(idxDraft, 10);
    const series_index = Number.isFinite(n) && n > 0 ? n - 1 : 0; //store 0-based
    setEditMeta(null);
    try {
      await api(`/api/books/${encodeURIComponent(bookId)}/meta`, {
        method: "PATCH", body: JSON.stringify({ series: seriesDraft.trim(), series_index }),
      });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  //where the dragged id should sit relative to the unit under the pointer. the side is decided by the
  //pointer vs the target's midpoint (geometry, so it doesn't flip-flop as items reflow): for vertical
  //series blocks that's the top/bottom half, for the books grid the left/right half of the cell.
  function computeOrder(e: React.DragEvent, base: string[], targetId: string): string[] {
    const cur = preview ?? base;
    if (!dragId || targetId === dragId) return cur;
    if (cur.indexOf(dragId) < 0 || cur.indexOf(targetId) < 0) return cur;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = grouped ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    const next = cur.filter((x) => x !== dragId);
    let ti = next.indexOf(targetId);
    if (after) ti += 1;
    next.splice(ti, 0, dragId);
    return next;
  }
  //throttle reorders so each slide animation settles before the next one — this is what stops the jitter
  const lastMove = useRef(0);
  function dragOver(e: React.DragEvent, base: string[], targetId: string) {
    if (!dragId) return;
    const now = performance.now();
    if (now - lastMove.current < SLIDE_MS) return;
    const next = computeOrder(e, base, targetId);
    if (next.join("|") !== (preview ?? base).join("|")) { setPreview(next); lastMove.current = now; }
  }
  //drop: place at the final pointer position (ignoring the throttle) and commit the new order
  function dropOn(e: React.DragEvent, base: string[], targetId: string) {
    if (dragId) update(withOrder(prefs, grouped, computeOrder(e, base, targetId)));
    setDragId(null); setPreview(null);
  }
  //dropped outside any unit (cancel): revert to the saved order
  function clearDrag() { setDragId(null); setPreview(null); setDragHandle(null); }

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

  const externalBooks = (books || []).filter(isExternal);

  //one grid for every device book: those with contexts (real Book rows) plus the device's other books from
  //the read-history catalog (no notes yet, shown dimmed with "start contexts", hidden when the user turns
  //them off in settings). series grouping is read-only here — it comes from each book's koreader metadata,
  //so it's changed in koreader, not on the web. library entries already exclude anything that has a Book
  //row, so there are no duplicates.
  type DeviceCard = BookSummary & { started: boolean };
  //started books carry their synced reading_progress; unstarted library entries have none
  const startedBooks: DeviceCard[] = (books || []).filter((b) => !isExternal(b)).map((b) => ({ ...b, started: true }));
  const libraryCards: DeviceCard[] = showUnstarted
    ? library.map((e) => ({ book_id: e.book_id, title: e.title, authors: e.authors, cover: e.cover, series: e.series || "", series_index: e.series_index ?? 0, started: false }))
    : [];
  const deviceBooks: DeviceCard[] = [...startedBooks, ...libraryCards];

  //within a series, sort by series position (then title) so editing an index reorders the books; a
  //started/unstarted split only breaks ties
  const cardOrder = (a: DeviceCard, b: DeviceCard) => byOrder(a, b) || Number(b.started) - Number(a.started);
  const titleKey = (b: DeviceCard) => (b.title || b.book_id).toLowerCase();
  //author sort key honours the chosen direction: by last name (default) or the whole "First Last" string
  const authorSortKey = (authors: string) => (prefs.authorSort === "first" ? (authors || "").toLowerCase() : lastNameKey(authors || ""));
  const authorKey = (b: DeviceCard) => authorSortKey(b.authors || "");
  const pinFirst = (ids: string[], pins: string[]) => {
    const set = new Set(pins);
    return [...ids.filter((x) => set.has(x)), ...ids.filter((x) => !set.has(x))];
  };

  //flat mode: every book is its own card, ordered by the chosen sort, pinned books floated to the top
  function orderedBooks(): DeviceCard[] {
    const by = new Map(deviceBooks.map((b) => [b.book_id, b] as const));
    let ids = deviceBooks.map((b) => b.book_id);
    if (sort === "title") ids.sort((a, b) => titleKey(by.get(a)!).localeCompare(titleKey(by.get(b)!)));
    else if (sort === "author") ids.sort((a, b) => authorKey(by.get(a)!).localeCompare(authorKey(by.get(b)!)) || titleKey(by.get(a)!).localeCompare(titleKey(by.get(b)!)));
    else ids = applyManualOrder(ids, prefs.orderBooks);
    return pinFirst(ids, prefs.pinBooks).map((id) => by.get(id)!);
  }

  //grouped mode: bucket by series, order the series sections by the chosen sort (pinned series first)
  const groups = new Map<string, DeviceCard[]>();
  for (const b of deviceBooks) {
    const s = b.series || "";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(b);
  }
  const seriesAuthor = (s: string) => authorSortKey((groups.get(s) || []).slice().sort(cardOrder)[0]?.authors || "");
  function orderedSeries(): string[] {
    let keys = [...groups.keys()];
    if (sort === "manual") {
      keys = applyManualOrder(keys, prefs.orderSeries);
    } else {
      const named = keys.filter((s) => s);
      if (sort === "author") named.sort((a, b) => seriesAuthor(a).localeCompare(seriesAuthor(b)) || a.toLowerCase().localeCompare(b.toLowerCase()));
      else named.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      keys = groups.has("") ? [...named, ""] : named; //unfiled bucket last
    }
    return pinFirst(keys, prefs.pinSeries);
  }

  //reset the manual arrangement: re-seed the saved order for the current mode from a chosen sort
  //(author or title), staying in manual so the user can keep tweaking from that starting point. pinned
  //items are left exactly where they are — they float to the top, so only the unpinned rest gets resorted.
  function resetOrder(by: "author" | "title") {
    let ids: string[];
    if (grouped) {
      const named = [...groups.keys()].filter((s) => s);
      if (by === "author") named.sort((a, b) => seriesAuthor(a).localeCompare(seriesAuthor(b)) || a.toLowerCase().localeCompare(b.toLowerCase()));
      else named.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      ids = groups.has("") ? [...named, ""] : named;
    } else {
      const m = new Map(deviceBooks.map((b) => [b.book_id, b] as const));
      ids = deviceBooks.map((b) => b.book_id);
      if (by === "title") ids.sort((a, b) => titleKey(m.get(a)!).localeCompare(titleKey(m.get(b)!)));
      else ids.sort((a, b) => authorKey(m.get(a)!).localeCompare(authorKey(m.get(b)!)) || titleKey(m.get(a)!).localeCompare(titleKey(m.get(b)!)));
    }
    //keep pinned items in their current order at the front; resort only the unpinned ones
    const pinSet = new Set(pinsFor(prefs, grouped));
    const currentPinned = (grouped ? orderedSeries() : orderedBooks().map((b) => b.book_id)).filter((id) => pinSet.has(id));
    update(withOrder(prefs, grouped, [...currentPinned, ...ids.filter((id) => !pinSet.has(id))]));
  }

  //the order actually shown: the saved order, with the live drag preview applied for the active mode.
  const byId = new Map(deviceBooks.map((b) => [b.book_id, b] as const));
  const seriesIds = grouped && preview ? preview.filter((s) => groups.has(s)) : orderedSeries();
  const bookIds = !grouped && preview ? preview.filter((id) => byId.has(id)) : orderedBooks().map((b) => b.book_id);
  //pinned and unpinned series are rendered as two separate stacks with independent slide animations, so a
  //reorder of one never visually drags an item across the other (which caused a flash above the pins).
  const pinnedSeries = seriesIds.filter((s) => prefs.pinSeries.includes(s));
  const unpinnedSeries = seriesIds.filter((s) => !prefs.pinSeries.includes(s));
  //re-run the slide animation whenever each shown order changes (hooks, so they run every render)
  const registerFlipPinned = useFlip(pinnedSeries.join("|"));
  const registerFlipUnpinned = useFlip(unpinnedSeries.join("|"));
  const registerFlipBooks = useFlip(bookIds.join("|"));

  const gridClass = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 items-start gap-2.5";
  const pinToggle = (id: string, pinned: boolean) => (
    <button onClick={(e) => { e.stopPropagation(); togglePin(id); }} onPointerDown={(e) => e.stopPropagation()}
            title={pinned ? "Unpin" : "Pin to top"} aria-label={pinned ? "Unpin" : "Pin to top"}
            className={`shrink-0 text-sm leading-none transition ${pinned ? "text-accent" : "text-ink-faint hover:text-ink"}`}>
      {pinned ? "★" : "☆"}
    </button>
  );

  //the series line: click it to hand-edit (covers the "koreader got the index wrong" case)
  const seriesRow = (b: DeviceCard) => (
    <button className="block w-full text-left text-xs text-ink-soft truncate hover:text-accent-hover transition"
            title="Click to edit series" onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); startEditMeta(b); }}>
      {b.series ? `${b.series} · #${(b.series_index ?? 0) + 1}` : <span className="text-ink-faint italic">no series, click to set one</span>}
    </button>
  );
  const ed = "w-full px-1.5 py-1 rounded-md border border-line bg-paper-card text-xs focus:outline-none focus:border-accent-ring";
  const seriesEditor = (b: DeviceCard) => (
    <div className="mt-2 pt-2 border-t border-line space-y-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <input className={ed} placeholder="series name (blank to clear)" value={seriesDraft} onChange={(e) => setSeriesDraft(e.target.value)} />
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-ink-faint">#</span>
        <input type="number" min={1} className={`${ed} w-16`} value={idxDraft} onChange={(e) => setIdxDraft(e.target.value)} />
        <span className="flex-1" />
        <button className="text-xs text-ink-soft hover:text-ink" onClick={(e) => { e.stopPropagation(); setEditMeta(null); }}>Cancel</button>
        <button className="text-xs font-semibold text-accent-hover hover:underline" onClick={(e) => { e.stopPropagation(); void saveMeta(b.book_id); }}>Save</button>
      </div>
    </div>
  );

  //reading progress bar with the rounded percent at the end, for books we have a synced position for
  const progressBar = (frac: number) => {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    return (
      <div className="mt-2 flex items-center gap-1.5" title={`${pct}% read`}>
        <div className="flex-1 h-1.5 rounded-full bg-paper-sunk overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] tabular-nums text-ink-faint shrink-0">{pct}%</span>
      </div>
    );
  };

  //a single book card. draggable (manual flat mode) and pinnable only when the book itself is the unit.
  //dragging is suspended while its series is being edited so the inputs work normally.
  const renderCard = (b: DeviceCard, draggable: boolean, pinnable: boolean) => {
    const canDrag = draggable && editMeta !== b.book_id;
    return (
    <div key={b.book_id} ref={registerFlipBooks(b.book_id)}
         draggable={canDrag || undefined}
         onDragStart={canDrag ? (e) => { setDragId(b.book_id); e.dataTransfer.effectAllowed = "move"; } : undefined}
         onDragEnd={canDrag ? clearDrag : undefined}
         onDragOver={canDrag ? (e) => { e.preventDefault(); dragOver(e, bookIds, b.book_id); } : undefined}
         onDrop={canDrag ? (e) => { e.preventDefault(); dropOn(e, bookIds, b.book_id); } : undefined}
         className={`group/card relative w-full rounded-xl border border-line bg-paper-card p-3 shadow-card transition hover:shadow-pop hover:border-accent-ring ${
           canDrag ? "cursor-move" : "cursor-pointer"} ${dragId === b.book_id ? "opacity-40 ring-2 ring-accent-ring" : ""} ${b.started ? "" : "opacity-65 hover:opacity-100"}`}>
      {pinnable && <div className="absolute top-1 right-1 z-10">{pinToggle(b.book_id, prefs.pinBooks.includes(b.book_id))}</div>}
      <button className="group flex w-full items-start gap-2.5 text-left"
              onClick={() => (b.started ? open(b) : adopt(b.book_id))}>
        <Cover src={b.cover} title={b.title} />
        <span className="min-w-0 flex-1">
          <strong className="block truncate group-hover:text-accent-hover transition">{b.title || b.book_id}</strong>
          {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
        </span>
      </button>
      {showProgress && b.started && b.reading_progress != null && progressBar(b.reading_progress)}
      {editMeta === b.book_id ? seriesEditor(b) : b.started ? (
        <>
          {(b.profiles?.length ?? 0) >= 1 && (
            <label className="mt-2 block">
              <span className="block text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Profile</span>
              {profileDropdown(b)}
            </label>
          )}
          <div className="mt-2 pt-2 border-t border-line">{seriesRow(b)}</div>
        </>
      ) : (
        <div className="mt-2 pt-2 border-t border-line">
          <button className="text-xs font-medium text-accent-hover hover:underline transition"
                  onClick={() => adopt(b.book_id)}>+ start contexts</button>
          <div className="mt-1">{seriesRow(b)}</div>
        </div>
      )}
    </div>
    );
  };

  //one series block. `register` is the FLIP ref callback for the stack it belongs to (pinned vs unpinned),
  //so its slide animation stays scoped to that stack. drag still operates over the full seriesIds order.
  const renderSeries = (series: string, register: (id: string) => (el: HTMLElement | null) => void) => {
    const list = (groups.get(series) || []).slice().sort(cardOrder);
    const draggable = sort === "manual";
    //drag is started only from the grip in the top-left: the block becomes draggable while its grip is
    //held, never from a blank click in the body. it's still a drop target anywhere, so you can drop a
    //block onto any other block to reorder.
    const armed = draggable && dragHandle === series;
    return (
      <div key={series || "_none"} ref={register(series)}
           draggable={armed || undefined}
           onDragStart={armed ? (e) => { setDragId(series); e.dataTransfer.effectAllowed = "move"; } : undefined}
           onDragEnd={draggable ? clearDrag : undefined}
           onDragOver={draggable ? (e) => { e.preventDefault(); dragOver(e, seriesIds, series); } : undefined}
           onDrop={draggable ? (e) => { e.preventDefault(); dropOn(e, seriesIds, series); } : undefined}
           className={`mb-6 rounded-xl border border-line p-4 transition ${
             dragId === series ? "opacity-40 ring-2 ring-accent-ring ring-offset-2 ring-offset-paper" : ""}`}>
        <div className="flex items-center gap-2 mb-2">
          {draggable && (
            <span className="text-ink-faint hover:text-ink select-none leading-none cursor-move" aria-hidden
                  title="Drag to reorder"
                  onMouseDown={() => setDragHandle(series)} onMouseUp={() => setDragHandle(null)}>⠿</span>
          )}
          {pinToggle(series, prefs.pinSeries.includes(series))}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
            {series || "Not in a series"}
          </span>
          <span className="text-xs text-ink-faint tabular-nums">{list.length}</span>
        </div>
        <div className={gridClass}>
          {list.map((b) => renderCard(b, false, false))}
        </div>
      </div>
    );
  };

  if (!books) return <p className="text-ink-faint">Loading…</p>;

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Your books</h2>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-ink-soft">
          Sort by
          <select className={`${input} py-1 text-sm`} value={sort}
                  onChange={(e) => update({ ...prefs, sort: e.target.value as HomeSort })}>
            <option value="author">Author</option>
            <option value="title">Title</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {sort === "author" && (
          //author sort can go by last name (default) or first name
          <label className="flex items-center gap-1 text-xs text-ink-soft">
            by
            <select className={`${input} py-1 text-sm`} value={prefs.authorSort} aria-label="Author sort order"
                    onChange={(e) => update({ ...prefs, authorSort: e.target.value as AuthorSort })}>
              <option value="last">Last name</option>
              <option value="first">First name</option>
            </select>
          </label>
        )}
        {sort === "manual" && deviceBooks.length > 0 && (
          //a plain "Reset order" button that opens a small menu of what to re-seed the manual order from
          <div className="relative" ref={resetRef}>
            <button className={`${input} py-1 text-sm`} onClick={() => setResetOpen((v) => !v)}
                    aria-haspopup="menu" aria-expanded={resetOpen}>
              Reset order
            </button>
            {resetOpen && (
              <div role="menu" className="absolute right-0 z-30 mt-1 w-36 rounded-lg border border-line bg-paper-card shadow-pop py-1">
                {(["author", "title"] as const).map((by) => (
                  <button key={by} role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-paper-sunk transition"
                          onClick={() => { resetOrder(by); setResetOpen(false); }}>
                    to {by === "author" ? "Author" : "Title"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer select-none">
          <input type="checkbox" checked={grouped} onChange={(e) => update({ ...prefs, group: e.target.checked })} />
          Group by series
        </label>
      </div>

      {sort === "manual" && deviceBooks.length > 0 && (
        <p className="text-xs text-ink-faint mb-2">
          {grouped ? <>Drag series by the <span className="font-mono">⠿</span> grip to arrange</> : "Drag books to arrange"} · {"☆"} pins to the top.
        </p>
      )}

      {deviceBooks.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper-card p-6 text-center mb-5">
          <p className="font-medium">No books yet</p>
          <p className="text-sm text-ink-faint mt-1">Open a book in KOReader and sync — your library shows up here, ready to annotate.</p>
        </div>
      )}

      {grouped ? (
        //two independent stacks: pinned series, then the rest. each animates within itself.
        <>
          {pinnedSeries.map((s) => renderSeries(s, registerFlipPinned))}
          {unpinnedSeries.map((s) => renderSeries(s, registerFlipUnpinned))}
        </>
      ) : (
        <div className={`${gridClass} mb-5`}>
          {bookIds.map((id) => renderCard(byId.get(id)!, sort === "manual", true))}
        </div>
      )}

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
