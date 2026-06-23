import { useEffect, useRef, useState } from "react";
import { btn } from "./ui";
import { ConfirmDialog } from "./Modal";
import { TrashImg } from "./icons";
import type { ProfileSummary } from "./types";

//the per-book profile switcher: a book can hold several named context documents (e.g. "Main",
//"Spoiler-free reread"). this picks which one the web is viewing/editing. the device picks its own
//independently. switching, creating (blank or a copy of the current notes), renaming and deleting all
//route back through callbacks in BookView so the right ?profile= calls happen.
export default function ProfilePicker({ profiles, activeId, activeName, onSwitch, onCreate, onRename, onDelete, onExportExternal, onClear }: {
  profiles: ProfileSummary[];
  activeId: string;
  activeName: string;            //name of the active profile incl. the not-yet-saved implicit "Main"
  onSwitch: (id: string) => void;
  onCreate: (name: string, copyCurrent: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onExportExternal: () => void;  //copy the active profile into the standalone "Imported" set
  onClear: () => void;           //empty the active profile's notes
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [copyCurrent, setCopyCurrent] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDel, setConfirmDel] = useState<ProfileSummary | null>(null); //profile pending delete confirm
  const ref = useRef<HTMLDivElement>(null);

  //a freshly adopted book has no saved profile yet, just the implicit "Main" (created on first note). it
  //isn't in `profiles`, so reserve its name explicitly — otherwise you could make a second "Main".
  const empty = profiles.length === 0;
  //names must be unique within a book (case-insensitive). `exceptId` skips the profile being renamed.
  const nameTaken = (name: string, exceptId?: string) => {
    const t = name.trim().toLowerCase();
    if (empty) return t === activeName.trim().toLowerCase();
    return profiles.some((p) => p.profile_id !== exceptId && p.name.trim().toLowerCase() === t);
  };
  const newDup = !!newName.trim() && nameTaken(newName);

  //close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function close() { setOpen(false); setAdding(false); setNewName(""); setRenaming(null); }
  const active = profiles.find((p) => p.profile_id === activeId);

  function submitNew() {
    const name = newName.trim();
    if (!name || nameTaken(name)) return;  //block blank or duplicate names
    onCreate(name, copyCurrent && !empty);  //nothing to copy from on a book with no saved profile yet
    setAdding(false); setNewName(""); setOpen(false);
  }
  function submitRename(id: string) {
    const name = renameText.trim();
    if (name && !nameTaken(name, id)) onRename(id, name);  //ignore a rename to a name already in use
    setRenaming(null);
  }

  return (
    <div className="relative" ref={ref}>
      <button className={btn} onClick={() => setOpen((o) => !o)} title="Switch / manage profiles" aria-expanded={open}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 7h18M3 12h18M3 17h10" strokeLinecap="round" />
        </svg>
        <span className="max-w-[140px] truncate">{active?.name || activeName}</span>
        <span className="text-ink-faint text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-xl border border-line bg-paper-card shadow-card p-1.5">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Profiles</div>
          <div className="flex flex-col gap-0.5 max-h-72 overflow-auto">
            {profiles.map((p) => {
              const isActive = p.profile_id === activeId;
              if (renaming === p.profile_id) {
                return (
                  <form key={p.profile_id} onSubmit={(e) => { e.preventDefault(); submitRename(p.profile_id); }}
                        className="flex items-center gap-1 px-1.5 py-1">
                    <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)}
                           onBlur={() => submitRename(p.profile_id)}
                           className="flex-1 min-w-0 px-2 py-1 rounded-md border border-line bg-paper text-sm outline-none" />
                  </form>
                );
              }
              return (
                <div key={p.profile_id}
                     className={`group flex items-center gap-1.5 rounded-lg pl-2 pr-1 py-1 transition ${isActive ? "bg-paper-sunk" : "hover:bg-paper-sunk"}`}>
                  <button className="flex-1 flex items-center gap-2 min-w-0 text-left text-sm"
                          onClick={() => { onSwitch(p.profile_id); close(); }}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-accent" : "bg-transparent"}`} />
                    <span className="truncate">{p.name}</span>
                  </button>
                  <button className="shrink-0 text-ink-faint hover:text-ink transition text-xs px-1 opacity-0 group-hover:opacity-100"
                          title="Rename" onClick={() => { setRenaming(p.profile_id); setRenameText(p.name); }}>✎</button>
                  <button className="group/trash shrink-0 p-1 opacity-0 group-hover:opacity-100" title="Delete profile"
                          onClick={() => setConfirmDel(p)}>
                    <TrashImg className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
            {/* a book with no saved profile yet: show the implicit profile (it's created on the first note) */}
            {empty && (
              <div className="flex items-center gap-2 rounded-lg pl-2 pr-1 py-1 bg-paper-sunk">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent" />
                <span className="flex-1 truncate text-sm">{activeName}</span>
                <span className="shrink-0 text-[10px] text-ink-faint pr-1">created on first note</span>
              </div>
            )}
          </div>

          {/* actions on the profile you're currently viewing (only once it actually exists) */}
          {!empty && (
          <div className="border-t border-line mt-1.5 pt-1.5 flex flex-col gap-0.5">
            <div className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint truncate">
              {active?.name || activeName}
            </div>
            <button className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink transition"
                    onClick={() => { onExportExternal(); close(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 3v12m0-12 4 4m-4-4-4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Save as standalone copy
            </button>
            <button className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink transition"
                    onClick={() => { onClear(); close(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Clear all notes
            </button>
          </div>
          )}

          <div className="border-t border-line mt-1.5 pt-1.5">
            {adding ? (
              <form onSubmit={(e) => { e.preventDefault(); submitNew(); }} className="px-1.5 flex flex-col gap-1.5">
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Profile name…"
                       className={`px-2 py-1.5 rounded-md border bg-paper text-sm outline-none ${
                         newDup ? "border-red-400 focus:border-red-400" : "border-line focus:border-accent-ring"}`} />
                {newDup && <span className="text-xs text-red-600 px-0.5">A profile named "{newName.trim()}" already exists.</span>}
                {!empty && (
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft px-0.5 cursor-pointer">
                    <input type="checkbox" checked={copyCurrent} onChange={(e) => setCopyCurrent(e.target.checked)} />
                    Start from a copy of "{active?.name || activeName}"
                  </label>
                )}
                <div className="flex gap-1.5 justify-end pb-0.5">
                  <button type="button" className="text-xs text-ink-faint hover:text-ink px-2 py-1" onClick={() => setAdding(false)}>Cancel</button>
                  <button type="submit" className="text-xs font-semibold text-accent hover:text-accent-hover px-2 py-1 disabled:opacity-40" disabled={!newName.trim() || newDup}>Create</button>
                </div>
              </form>
            ) : (
              <button className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink transition"
                      onClick={() => { setAdding(true); setCopyCurrent(true); }}>
                <span className="text-base leading-none">＋</span> New profile
              </button>
            )}
          </div>
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog title="Delete profile" danger confirmLabel="Delete"
                       onCancel={() => setConfirmDel(null)}
                       onConfirm={() => { const id = confirmDel.profile_id; setConfirmDel(null); close(); onDelete(id); }}
                       message={profiles.length === 1
                         ? <>Delete profile <strong>“{confirmDel.name}”</strong>? It's the only one, so this removes the book from your web contexts. Its notes can't be recovered.</>
                         : <>Delete profile <strong>“{confirmDel.name}”</strong>? Its notes can't be recovered.</>} />
      )}
    </div>
  );
}
