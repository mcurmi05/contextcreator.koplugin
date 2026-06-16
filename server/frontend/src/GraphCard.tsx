import { useState } from "react";
import PointItem from "./PointItem";
import { colorFor, isCustomType, pointText, pointProgress, typeLabel } from "./model";
import type { Context, GraphEditOps, Point, PointRef, Relationship, Selected } from "./types";

const pointRef = (p: Point, i: number): PointRef => ({ id: typeof p === "object" ? p.id : undefined, index: i });
const BUILTIN_TYPES = ["character", "place", "object", "concept", "unset"];

//grip shown in the header in fixed-card mode so the card can be dragged to its pinned spot
function Grip({ onDrag }: { onDrag?: (e: React.PointerEvent) => void }) {
  if (!onDrag) return null;
  return (
    <span onPointerDown={onDrag} title="Drag to move" aria-hidden="true"
          className="cursor-grab active:cursor-grabbing select-none touch-none text-ink-faint hover:text-ink -ml-1 pr-0.5">⠿</span>
  );
}

function CloseBtn({ onClose }: { onClose: () => void }) {
  return (
    <button className="text-ink-faint hover:text-ink transition leading-none text-lg" onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()} aria-label="Close">×</button>
  );
}

//the editor card for a context node: rename, retype, add/edit/delete dot points, manage its links, delete it
export function NodeCard({ ckey, ctx, contexts, relationships, typeColors, scrub, ops, onAddPoint, onEditPoint, onSelect, onDrag }: {
  ckey: string; ctx: Context; contexts: Record<string, Context>; relationships: Relationship[];
  typeColors: Record<string, string>; scrub: number; ops: GraphEditOps;
  onAddPoint: (key: string, text: string) => void;
  onEditPoint: (key: string, ref: PointRef, text: string) => void;
  onSelect: (s: Selected) => void; onDrag?: (e: React.PointerEvent) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(ctx.title);
  const [note, setNote] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [dir, setDir] = useState<"to" | "from" | "none">("to");

  const others = Object.entries(contexts).filter(([k]) => k !== ckey)
    .sort((a, b) => (a[1].title || a[0]).localeCompare(b[1].title || b[0]));
  const links = relationships.filter((r) => r.from === ckey || r.to === ckey);
  const types = isCustomType(ctx.type) ? [...BUILTIN_TYPES.slice(0, 4), ctx.type!, "unset"] : BUILTIN_TYPES;

  const saveTitle = () => { setEditingTitle(false); const t = titleDraft.trim(); if (t && t !== ctx.title) ops.renameContext(ckey, t); };
  const submitNote = () => { if (note.trim()) { onAddPoint(ckey, note.trim()); setNote(""); } };
  const create = () => {
    if (!target) return;
    const from = dir === "from" ? target : ckey;
    const to = dir === "from" ? ckey : target;
    ops.createLink(from, to, linkLabel, dir !== "none");
    setLinkOpen(false); setTarget(""); setLinkLabel(""); setDir("to");
  };

  return (
    <div className="w-72 max-h-[72vh] flex flex-col rounded-xl border border-line bg-paper-card shadow-pop overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <Grip onDrag={onDrag} />
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorFor(ctx.type, typeColors) }} />
        {editingTitle ? (
          <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} onBlur={saveTitle}
                 onPointerDown={(e) => e.stopPropagation()}
                 onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                 className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md border border-accent-ring bg-paper-card text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-accent-ring/30" />
        ) : (
          <strong className="flex-1 min-w-0 truncate cursor-text hover:bg-accent-soft rounded px-0.5 transition" title="Click to rename"
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => { setTitleDraft(ctx.title); setEditingTitle(true); }}>
            {ctx.title}
          </strong>
        )}
        <CloseBtn onClose={() => onSelect(null)} />
      </div>

      {/* type + delete */}
      {confirmDel ? (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-sm">
          <span className="flex-1">Delete this node and its links?</span>
          <button className="text-red-600 font-semibold hover:underline" onClick={() => ops.deleteContext(ckey)}>Delete</button>
          <button className="text-ink-soft hover:text-ink" onClick={() => setConfirmDel(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line">
          <span className="text-xs text-ink-faint">Type</span>
          <select value={ctx.type || "unset"} onChange={(e) => ops.setType(ckey, e.target.value)}
                  className="flex-1 text-sm bg-paper-card border border-line rounded-md px-1.5 py-1 focus:outline-none focus:border-accent-ring">
            {types.map((t) => <option key={t} value={t}>{typeLabel(t) || "No type"}</option>)}
          </select>
          <button className="text-ink-faint hover:text-red-600 transition text-sm" title="Delete node" onClick={() => setConfirmDel(true)}>Delete</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <ul className="px-4 py-2 space-y-1.5 text-sm">
          {(ctx.points || []).map((p, i) => (
            <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                       onSave={(t) => onEditPoint(ckey, pointRef(p, i), t)}
                       onDelete={() => ops.deletePoint(ckey, pointRef(p, i))} />
          ))}
          {(!ctx.points || ctx.points.length === 0) && <li className="text-ink-faint italic">no notes yet</li>}
        </ul>

        {/* links */}
        <div className="px-3 pb-2 pt-1 border-t border-line">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex-1">Links</span>
            <button className="text-xs text-accent-hover hover:underline" onClick={() => setLinkOpen((v) => !v)}>{linkOpen ? "Cancel" : "+ Add link"}</button>
          </div>
          <ul className="space-y-0.5 text-sm">
            {links.map((r) => {
              const otherKey = r.from === ckey ? r.to : r.from;
              const arrow = r.directed === false ? "↔" : (r.from === ckey ? "→" : "←");
              return (
                <li key={r.id} className="group flex items-center gap-1.5">
                  <button className="flex-1 min-w-0 text-left truncate hover:text-accent-hover transition"
                          onClick={() => onSelect({ kind: "relationship", id: r.id })}>
                    <span className="text-ink-faint">{arrow}</span> {contexts[otherKey]?.title || otherKey}
                    {r.label ? <span className="text-ink-faint"> · {r.label}</span> : null}
                  </button>
                  <button className="shrink-0 text-ink-faint hover:text-red-600 transition opacity-0 group-hover:opacity-100"
                          title="Delete link" onClick={() => ops.deleteLink(r.id)}>×</button>
                </li>
              );
            })}
            {links.length === 0 && !linkOpen && <li className="text-ink-faint italic">no links yet</li>}
          </ul>

          {linkOpen && (
            <div className="mt-2 flex flex-col gap-1.5">
              <select value={target} onChange={(e) => setTarget(e.target.value)}
                      className="text-sm bg-paper-card border border-line rounded-md px-1.5 py-1 focus:outline-none focus:border-accent-ring">
                <option value="">Link to…</option>
                {others.map(([k, c]) => <option key={k} value={k}>{c.title || k}</option>)}
              </select>
              <div className="flex gap-1">
                {([["to", "→ to"], ["from", "← from"], ["none", "↔ both"]] as const).map(([v, lbl]) => (
                  <button key={v} onClick={() => setDir(v)}
                          className={`flex-1 px-1 py-1 rounded-md text-xs font-medium border transition ${
                            dir === v ? "border-accent bg-accent text-white" : "border-line text-ink-soft hover:bg-paper-sunk"}`}>{lbl}</button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <input className="flex-1 px-2 py-1 rounded-md border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring"
                       placeholder="label (optional)" value={linkLabel}
                       onChange={(e) => setLinkLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
                <button className="px-2.5 py-1 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition disabled:opacity-50"
                        disabled={!target} onClick={create}>Link</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-1.5 p-2 border-t border-line bg-paper">
        <input className="flex-1 px-2.5 py-1.5 rounded-lg border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring focus:ring-2 focus:ring-accent-ring/30"
               placeholder="add a note…" value={note}
               onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitNote()} />
        <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition" onClick={submitNote}>Add</button>
      </div>
    </div>
  );
}

//the editor card for a relationship: edit label, flip/undirect, add/edit/delete its dot points, delete it
export function RelCard({ rel, contexts, scrub, ops, onSelect, onDrag }: {
  rel: Relationship; contexts: Record<string, Context>; scrub: number; ops: GraphEditOps;
  onSelect: (s: Selected) => void; onDrag?: (e: React.PointerEvent) => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(rel.label || "");
  const [note, setNote] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const fromT = contexts[rel.from]?.title || rel.from;
  const toT = contexts[rel.to]?.title || rel.to;
  const directed = rel.directed !== false;
  const saveLabel = () => { setEditingLabel(false); ops.editLinkLabel(rel.id, labelDraft); };
  const submitNote = () => { if (note.trim()) { ops.addRelPoint(rel.id, note.trim()); setNote(""); } };

  return (
    <div className="w-72 max-h-[72vh] flex flex-col rounded-xl border border-line bg-paper-card shadow-pop overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <Grip onDrag={onDrag} />
        <strong className="flex-1 min-w-0 truncate text-sm">{fromT} {directed ? "→" : "↔"} {toT}</strong>
        <CloseBtn onClose={() => onSelect(null)} />
      </div>

      {/* label + direction */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line">
        {editingLabel ? (
          <input autoFocus value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} onBlur={saveLabel}
                 onKeyDown={(e) => { if (e.key === "Enter") saveLabel(); if (e.key === "Escape") setEditingLabel(false); }}
                 placeholder="label" className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md border border-accent-ring bg-paper-card text-sm focus:outline-none focus:ring-2 focus:ring-accent-ring/30" />
        ) : (
          <span className="flex-1 min-w-0 truncate text-sm cursor-text hover:bg-accent-soft rounded px-0.5 transition" title="Click to edit label"
                onClick={() => { setLabelDraft(rel.label || ""); setEditingLabel(true); }}>
            {rel.label || <span className="text-ink-faint italic">add a label</span>}
          </span>
        )}
        <button className="text-sm px-1.5 py-0.5 rounded-md border border-line hover:bg-paper-sunk transition" title={directed ? "Make undirected" : "Make directed"}
                onClick={() => ops.setLinkDirection(rel.id, rel.from, rel.to, !directed)}>{directed ? "→" : "↔"}</button>
        <button className="text-sm px-1.5 py-0.5 rounded-md border border-line hover:bg-paper-sunk transition" title="Swap direction"
                onClick={() => ops.setLinkDirection(rel.id, rel.to, rel.from, directed)}>⇄</button>
      </div>

      <ul className="flex-1 overflow-auto px-4 py-2 space-y-1.5 text-sm">
        {(rel.points || []).map((p, i) => (
          <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                     onSave={(t) => ops.editRelPoint(rel.id, pointRef(p, i), t)}
                     onDelete={() => ops.deleteRelPoint(rel.id, pointRef(p, i))} />
        ))}
        {(!rel.points || rel.points.length === 0) && <li className="text-ink-faint italic">no notes on this link</li>}
      </ul>

      {confirmDel ? (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-line text-sm">
          <span className="flex-1">Delete this link?</span>
          <button className="text-red-600 font-semibold hover:underline" onClick={() => ops.deleteLink(rel.id)}>Delete</button>
          <button className="text-ink-soft hover:text-ink" onClick={() => setConfirmDel(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex gap-1.5 p-2 border-t border-line bg-paper">
          <input className="flex-1 px-2.5 py-1.5 rounded-lg border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring focus:ring-2 focus:ring-accent-ring/30"
                 placeholder="add a note…" value={note}
                 onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitNote()} />
          <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition" onClick={submitNote}>Add</button>
          <button className="px-2 py-1.5 rounded-lg border border-line text-ink-faint hover:text-red-600 transition text-sm" title="Delete link" onClick={() => setConfirmDel(true)}>🗑</button>
        </div>
      )}
    </div>
  );
}
