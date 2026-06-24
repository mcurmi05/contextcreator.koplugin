import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import Graph from "./Graph";
import Browse from "./Browse";
import Timeline from "./Timeline";
import DetailPanel from "./DetailPanel";
import ProfilePicker from "./ProfilePicker";
import Modal, { InfoDialog, ConfirmDialog } from "./Modal";
import { btn, btnAccent, input } from "../lib/ui";
import { TYPE_LABELS } from "../lib/model";
import { loadTypeColors, saveTypeColors } from "../lib/typeColors";
import { downloadJson, readJsonFile, slug } from "../lib/files";
import * as dq from "../lib/docops";
import { loadProfile, saveProfile } from "../lib/profilePref";
import type { GraphPrefs } from "../lib/theme";
import type { DevicePosition, Doc, GraphEditOps, ProfileSummary, Selected } from "../lib/types";

export default function BookView({ bookId, profileName, onProfileChange, onBack, graph, onGraphChange }: {
  bookId: string;
  profileName?: string;                                  //active profile name from the URL (/<bookId>/<name>)
  onProfileChange: (name: string | undefined) => void;   //update the URL when the active profile changes
  onBack: () => void; graph: GraphPrefs; onGraphChange: (g: GraphPrefs) => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tab, setTab] = useState<"graph" | "browse">("graph");
  const [scrub, setScrub] = useState(0); //0..1 narrative progress (1 = everything). starts at 0 so the
                                         //timeline doesn't flash "show all" before the reading position loads
  const [selected, setSelected] = useState<Selected>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [typeColors, setTypeColors] = useState<Record<string, string>>(loadTypeColors);
  const [undoStack, setUndoStack] = useState<Doc[]>([]);
  const [redoStack, setRedoStack] = useState<Doc[]>([]);
  const [profile, setProfile] = useState<string>(() => loadProfile(bookId));
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [devices, setDevices] = useState<DevicePosition[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const lastUpdated = useRef<number | undefined>(undefined);
  const didAutoScrub = useRef<string | null>(null); //bookId we've already jumped-to-current for
  //styled add dialogs for the graph view (in place of window.prompt)
  const [addCtx, setAddCtx] = useState<{ name: string; type: string } | null>(null);
  const [addRel, setAddRel] = useState<{ from: string; to: string; label: string; directed: boolean } | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null); //styled info dialog
  const [confirmClear, setConfirmClear] = useState(false); //"clear all notes" confirmation
  const [confirmPromote, setConfirmPromote] = useState<{ key: string; index: number } | null>(null); //alias→main name confirm

  //every notes call is scoped to the active profile via ?profile=
  const bookUrl = useCallback(
    (suffix = "") => `/api/books/${encodeURIComponent(bookId)}${suffix}` +
      `${suffix.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile)}`,
    [bookId, profile],
  );

  const loadProfiles = useCallback(async () => {
    try {
      const list = await api<ProfileSummary[]>(`/api/books/${encodeURIComponent(bookId)}/profiles`);
      //only swap state when something actually changed, so polling doesn't churn the picker every tick
      setProfiles((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
    } catch { /* ignore */ }
  }, [bookId]);
  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  //per-device reading positions for the timeline's "jump to current" (book-level, not profile-scoped).
  //polled so a device that just synced shows up without a refresh.
  const loadDevices = useCallback(async () => {
    try { setDevices(await api<DevicePosition[]>(`/api/books/${encodeURIComponent(bookId)}/devices`)); }
    catch { /* ignore */ }
    finally { setDevicesLoaded(true); }
  }, [bookId]);
  useEffect(() => {
    setDevicesLoaded(false);
    void loadDevices();
    const t = setInterval(() => { void loadDevices(); }, 5000);
    return () => clearInterval(t);
  }, [loadDevices]);

  //open the timeline jumped to where the reader is up to (freshest device, else the shared position),
  //not at the very end. runs once per book once both the doc and the device list have loaded; after that
  //the user is free to scrub anywhere without it snapping back.
  useEffect(() => {
    if (!doc || !devicesLoaded || didAutoScrub.current === bookId) return;
    didAutoScrub.current = bookId;
    const dev = devices.find((d) => typeof d.reading_progress === "number");
    const rp = dev ? dev.reading_progress
      : (typeof doc.reading_progress === "number" ? doc.reading_progress : null);
    if (rp != null) setScrub(Math.max(0, Math.min(1, rp)));
  }, [doc, devices, devicesLoaded, bookId]);

  const reload = useCallback(async () => {
    const d = await api<Doc>(bookUrl());
    lastUpdated.current = d.updated;
    setDoc(d);
  }, [bookUrl]);

  useEffect(() => { void reload().catch(() => {}); }, [reload]);

  //poll so edits synced from the device show up without a refresh (re-render only when changed). also
  //refresh the profile list, so a profile renamed/added/deleted on the device updates the picker live.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const d = await api<Doc>(bookUrl());
        if (d.updated !== lastUpdated.current) { lastUpdated.current = d.updated; setDoc(d); }
      } catch { /* ignore transient errors */ }
      void loadProfiles();
    }, 5000);
    return () => clearInterval(t);
  }, [bookUrl, loadProfiles]);

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
    const saved = await api<Doc>(bookUrl(), { method: "PUT", body: JSON.stringify(next) });
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
    if (!doc?.book?.toc?.length) return;  //no timeline yet -> nowhere to anchor it, so block the add
    const hadProfile = profiles.length > 0;
    await edit(() => api(bookUrl("/contexts"), {
      method: "POST", body: JSON.stringify({ title, type, progress: scrub }),
    }).then(() => {}));
    //the first context on a freshly adopted book materialises its Main profile server-side; refresh the
    //picker so it shows up
    if (!hadProfile) void loadProfiles();
  }
  async function addPoint(key: string, text: string) {
    if (!doc?.book?.toc?.length) return;  //no timeline yet -> nowhere to anchor it, so block the add
    await edit(() => api(bookUrl(`/contexts/${encodeURIComponent(key)}/points`), {
      method: "POST", body: JSON.stringify({ text, progress: scrub }),
    }).then(() => {}));
  }
  async function editPoint(key: string, ref: { id?: string; index: number }, text: string) {
    await edit(() => api(bookUrl(`/contexts/${encodeURIComponent(key)}/points`), {
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
    addAlias: (key, text) => {
      if (!doc) return "No document.";
      const next = structuredClone(doc) as Doc;
      const err = dq.addAlias(next, key, text);
      if (err) return err;            //rejected (e.g. name already in use): don't apply
      pushHistory(doc);
      void applyReplace(next);
      return null;
    },
    deleteAlias: (key, index) => { mutate((d) => dq.deleteAlias(d, key, index)); },
    //promoting is a destructive-ish rename, so confirm first; the actual swap runs in doPromoteAlias
    promoteAlias: (key, index) => setConfirmPromote({ key, index }),
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
      await edit(() => api(bookUrl("/import"), { method: "POST", body: JSON.stringify(data) }).then(() => {}));
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

  //load a profile's doc and start a clean undo history (the stacks belong to the profile you were
  //editing). the choice is remembered per book. driven by the URL via the reconcile effect below.
  function applyProfile(id: string) {
    if (id === profile) return;
    saveProfile(bookId, id);
    setUndoStack([]); setRedoStack([]); setSelected(null);
    lastUpdated.current = undefined;
    setProfile(id);
  }
  //the URL (/<bookId>/<profileName>) is the source of truth for which profile is active. when it names a
  //profile, switch to it; otherwise canonicalise the URL to the active profile's actual name (so a deep
  //link, a back/forward, a rename, or a switch all keep the address bar and the open profile in step).
  useEffect(() => {
    if (profiles.length === 0) return;
    const target = profileName
      ? profiles.find((p) => p.name.toLowerCase() === profileName.toLowerCase())
      : undefined;
    if (target) {
      if (target.profile_id !== profile) applyProfile(target.profile_id);
    } else {
      const activeName = profiles.find((p) => p.profile_id === profile)?.name;
      if (activeName && activeName !== profileName) onProfileChange(activeName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileName, profiles, profile]);

  //switching from the picker just updates the URL; the effect above does the actual load
  function chooseProfile(id: string) {
    onProfileChange(profiles.find((p) => p.profile_id === id)?.name);
  }
  async function createProfile(name: string, copyCurrent: boolean) {
    const made = await api<ProfileSummary>(`/api/books/${encodeURIComponent(bookId)}/profiles`, {
      method: "POST", body: JSON.stringify({ name, copy_from: copyCurrent ? profile : null }),
    });
    await loadProfiles();
    onProfileChange(made.name); //navigate to the new profile (the effect switches to it)
  }
  async function renameProfile(id: string, name: string) {
    await api(`/api/books/${encodeURIComponent(bookId)}/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ name }),
    });
    await loadProfiles(); //the effect canonicalises the URL if the active profile was the one renamed
  }
  async function deleteProfile(id: string) {
    let res: { book_removed?: boolean };
    try {
      res = await api<{ book_removed?: boolean }>(`/api/books/${encodeURIComponent(bookId)}/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) { alert((e as Error).message); return; }
    //deleting the last profile removes the book entirely — go back to the list, where a device book now
    //shows "start contexts" again
    if (res?.book_removed) { onBack(); return; }
    const rest = profiles.filter((p) => p.profile_id !== id);
    await loadProfiles();
    if (id === profile) onProfileChange(rest[0]?.name); //move to a remaining profile via the URL
  }
  //perform the confirmed alias→main-name swap: rename the context to the alias (old title kept as an alias)
  function doPromoteAlias() {
    const req = confirmPromote;
    setConfirmPromote(null);
    if (!doc || !req) return;
    const next = structuredClone(doc) as Doc;
    const newKey = dq.promoteAlias(next, req.key, req.index);
    pushHistory(doc);
    void applyReplace(next);
    if (newKey !== req.key) setSelected({ kind: "context", id: newKey }); //follow the renamed node
  }

  //empty the active profile's notes (tombstoned so the cleared state survives sync). undoable.
  function doClearProfile() {
    setConfirmClear(false);
    if (!doc) return;
    mutate((d) => dq.clearAll(d));
    setSelected(null);
  }
  //copy the active profile out into the standalone "Imported" set on the home page (leaves this one as is)
  async function sendProfileToImported() {
    try {
      const r = await api<{ title: string }>(`/api/books/${encodeURIComponent(bookId)}/profiles/${encodeURIComponent(profile)}/to-external`, { method: "POST" });
      setNotice({ title: "Saved as standalone copy", message: `Saved “${r.title}” to your Imported contexts on the Books screen.` });
    } catch (e) { setNotice({ title: "Couldn't save", message: (e as Error).message }); }
  }

  if (!doc) return <div className="h-full grid place-items-center text-ink-faint">Loading…</div>;

  const n = Object.keys(doc.contexts || {}).length;
  const rels = (doc.relationships || []).length;
  //the timeline needs the book's chapter list, which only the device produces (when the book is opened in
  //koreader). without it there's nowhere to anchor dot points, so for a device book we prompt the user to
  //open + sync first rather than letting them place notes against an empty timeline. external (web-only
  //imported) books can't be synced from koreader, so we don't nag about those.
  const hasTimeline = (doc.book?.toc || []).length > 0;
  const canSyncTimeline = doc.source !== "external";
  //the active profile's name: from the loaded list, else the doc's (covers the not-yet-saved "Main")
  const activeName = profiles.find((p) => p.profile_id === profile)?.name || doc.profile?.name || "Main";
  //contexts as relationship endpoints (for the "Add relationship" modal), by title
  const ctxList = Object.keys(doc.contexts || {})
    .map((k) => ({ k, title: doc.contexts[k]?.title || k }))
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

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
        <ProfilePicker profiles={profiles} activeId={profile} activeName={activeName}
                       onSwitch={chooseProfile} onCreate={createProfile} onRename={renameProfile} onDelete={deleteProfile}
                       onExportExternal={sendProfileToImported} onClear={() => setConfirmClear(true)} />
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
        {hasTimeline || !canSyncTimeline ? (
          <Timeline doc={doc} devices={devices} external={doc.source === "external"} scrub={scrub} onScrub={setScrub}
                    onAddContext={tab === "graph" && hasTimeline ? () => setAddCtx({ name: "", type: "unset" }) : undefined}
                    onAddRelationship={tab === "graph" && hasTimeline && Object.keys(doc.contexts || {}).length >= 2
                      ? () => setAddRel({ from: "", to: "", label: "", directed: true }) : undefined} />
        ) : (
          <div className="rounded-xl border border-dashed border-line-strong bg-paper-card px-4 py-3">
            <strong className="block text-sm">This book has no timeline yet</strong>
            <p className="text-sm text-ink-faint mt-0.5">
              Open it in KOReader and let it sync so the chapters and your reading position can load in.
            </p>
          </div>
        )}
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
                      hiddenTypes={hiddenTypes} typeColors={typeColors} onAddContext={addContext}
                      onAddRelationship={ops.createLink} canAdd={hasTimeline} />
            </div>
            <div className="w-[300px] shrink-0 h-full overflow-auto">
              <DetailPanel doc={doc} selected={selected} scrub={scrub} typeColors={typeColors} ops={ops} onAddPoint={addPoint} onEditPoint={editPoint} onClose={() => setSelected(null)} />
            </div>
          </div>
        )}
      </div>

      {/* styled "add" dialogs for the graph view (replacing window.prompt) */}
      {addCtx && (
        <Modal title="New context" onClose={() => setAddCtx(null)}>
          <form onSubmit={(e) => { e.preventDefault(); const t = addCtx.name.trim(); if (!t) return; void addContext(t, addCtx.type); setAddCtx(null); }}>
            <input autoFocus className={`${input} w-full`} placeholder="context name" value={addCtx.name}
                   onChange={(e) => setAddCtx({ ...addCtx, name: e.target.value })} />
            <select className={`${input} w-full mt-2`} value={addCtx.type} onChange={(e) => setAddCtx({ ...addCtx, type: e.target.value })}>
              <option value="unset">No type</option>
              {["character", "place", "object", "concept"].map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            <p className="text-xs text-ink-faint mt-2">Added at the current timeline position ({Math.round(scrub * 100)}%).</p>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className={btn} onClick={() => setAddCtx(null)}>Cancel</button>
              <button type="submit" className={btnAccent} disabled={!addCtx.name.trim()}>Add context</button>
            </div>
          </form>
        </Modal>
      )}

      {addRel && (
        <Modal title="New relationship" onClose={() => setAddRel(null)}>
          <form onSubmit={(e) => { e.preventDefault(); if (!addRel.from || !addRel.to || addRel.from === addRel.to) return; ops.createLink(addRel.from, addRel.to, addRel.label.trim(), addRel.directed); setAddRel(null); }}>
            <div className="flex items-center gap-2">
              <select className={`${input} flex-1 min-w-0`} value={addRel.from} onChange={(e) => setAddRel({ ...addRel, from: e.target.value })}>
                <option value="">from…</option>
                {ctxList.map((o) => <option key={o.k} value={o.k}>{o.title}</option>)}
              </select>
              <span className="text-ink-faint select-none">{addRel.directed ? "→" : "—"}</span>
              <select className={`${input} flex-1 min-w-0`} value={addRel.to} onChange={(e) => setAddRel({ ...addRel, to: e.target.value })}>
                <option value="">to…</option>
                {ctxList.map((o) => <option key={o.k} value={o.k}>{o.title}</option>)}
              </select>
            </div>
            <input className={`${input} w-full mt-2`} placeholder="label (optional)" value={addRel.label}
                   onChange={(e) => setAddRel({ ...addRel, label: e.target.value })} />
            <label className="flex items-center gap-1.5 text-sm text-ink-soft cursor-pointer mt-2 select-none">
              <input type="checkbox" className="h-4 w-4 accent-accent cursor-pointer" checked={addRel.directed}
                     onChange={(e) => setAddRel({ ...addRel, directed: e.target.checked })} />
              directed
            </label>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className={btn} onClick={() => setAddRel(null)}>Cancel</button>
              <button type="submit" className={btnAccent} disabled={!addRel.from || !addRel.to || addRel.from === addRel.to}>Add relationship</button>
            </div>
          </form>
        </Modal>
      )}

      {notice && <InfoDialog title={notice.title} message={notice.message} onClose={() => setNotice(null)} />}

      {confirmClear && (
        <ConfirmDialog title="Clear all notes" danger confirmLabel="Clear notes"
                       onCancel={() => setConfirmClear(false)} onConfirm={doClearProfile}
                       message={<>Clear all notes in <strong>“{activeName}”</strong>? The contexts, links and points are all removed. You can undo this.</>} />
      )}

      {confirmPromote && doc.contexts[confirmPromote.key]?.aliases?.[confirmPromote.index] && (
        <ConfirmDialog title="Make main name" confirmLabel="Make main name"
                       onCancel={() => setConfirmPromote(null)} onConfirm={doPromoteAlias}
                       message={<>Make <strong>“{doc.contexts[confirmPromote.key].aliases![confirmPromote.index]}”</strong> the main name
                         for <strong>“{doc.contexts[confirmPromote.key].title}”</strong>? The current name becomes an alias. You can undo this.</>} />
      )}
    </div>
  );
}
