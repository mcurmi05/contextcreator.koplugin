import { useState } from "react";
import PointItem from "./PointItem";
import { IconImg, TrashImg } from "./icons";
import { colorFor, isCustomType, pointText, pointProgress, typeLabel } from "../lib/model";
import type { Context, GraphEditOps, Point, PointRef, Relationship, Selected } from "../lib/types";

const pointRef = (p: Point, i: number): PointRef => ({ id: typeof p === "object" ? p.id : undefined, index: i });
const BUILTIN_TYPES = ["character", "place", "object", "concept", "unset"];

//grip shown in the header in fixed-card mode so the card can be dragged to its pinned spot
function Grip({ onDrag }: { onDrag?: (e: React.PointerEvent) => void }) {
  if (!onDrag) return null;
  return (
    <span onPointerDown={onDrag} title="Drag to move"
          className="cursor-grab active:cursor-grabbing select-none touch-none -ml-1 pr-0.5">
      <IconImg src="/drag.png" className="w-3.5 h-3.5 opacity-60" />
    </span>
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
  const [noteOpen, setNoteOpen] = useState(false); //toggle the add-dot-point form (mirrors "+ Add relationship")
  const [confirmDel, setConfirmDel] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customVal, setCustomVal] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [dir, setDir] = useState<"to" | "from" | "none">("to");
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasErr, setAliasErr] = useState("");
  const submitAlias = () => {
    const t = aliasDraft.trim();
    if (!t) return;
    const err = ops.addAlias(ckey, t);
    if (err) { setAliasErr(err); return; }
    setAliasDraft(""); setAliasErr("");
  };

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
  const applyCustom = () => { const t = customVal.trim(); if (t) { ops.setType(ckey, t); setCustomOpen(false); setCustomVal(""); } };

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
        <button className="group/trash shrink-0 flex items-center transition" title="Delete context"
                aria-label="Delete context" onPointerDown={(e) => e.stopPropagation()} onClick={() => setConfirmDel(true)}>
          <TrashImg className="w-4 h-4" />
        </button>
      </div>

      {/* type + delete */}
      {confirmDel ? (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-sm">
          <span className="flex-1">Delete this context and its relationships?</span>
          <button className="text-red-600 font-semibold hover:underline" onClick={() => ops.deleteContext(ckey)}>Delete</button>
          <button className="text-ink-soft hover:text-ink" onClick={() => setConfirmDel(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 px-3 py-1.5 border-b border-line">
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-faint">Type</span>
            <select value={ctx.type || "unset"} onChange={(e) => ops.setType(ckey, e.target.value)}
                    className="flex-1 text-sm bg-paper-card border border-line rounded-md px-1.5 py-1 focus:outline-none focus:border-accent-ring">
              {types.map((t) => <option key={t} value={t}>{typeLabel(t) || "No type"}</option>)}
            </select>
            <button className="text-xs text-accent-hover hover:underline shrink-0"
                    onClick={() => { setCustomOpen((v) => !v); setCustomVal(""); }}>{customOpen ? "Cancel" : "+ custom"}</button>
          </div>
          {customOpen && (
            <div className="flex gap-1.5">
              <input autoFocus className="flex-1 px-2 py-1 rounded-md border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring"
                     placeholder="custom type name" value={customVal}
                     onChange={(e) => setCustomVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCustom()} />
              <button className="px-2.5 py-1 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition disabled:opacity-50"
                      disabled={!customVal.trim()} onClick={applyCustom}>Set</button>
            </div>
          )}
        </div>
      )}

      {!confirmDel && (
        <div className="px-3 py-1.5 border-b border-line text-xs">
          <button className="flex items-center gap-1 text-ink-soft hover:text-ink transition"
                  onClick={() => setAliasesOpen((v) => !v)} aria-expanded={aliasesOpen}>
            <span className={`transition-transform ${aliasesOpen ? "rotate-90" : ""}`}>›</span>
            <span className="font-medium">Aliases</span>
            <span className="text-ink-faint tabular-nums">({ctx.aliases?.length ?? 0})</span>
          </button>
          {aliasesOpen && (
            <div className="mt-1 pl-4 space-y-1">
              {(ctx.aliases || []).map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 group/al">
                  <span className="flex-1 min-w-0 truncate text-ink-faint">{a}</span>
                  <button className="shrink-0 text-ink-faint hover:text-accent-hover transition opacity-60 group-hover/al:opacity-100"
                          title="Make this the main name" aria-label="Make main name"
                          onPointerDown={(e) => e.stopPropagation()} onClick={() => ops.promoteAlias(ckey, i)}>↑</button>
                  <button className="shrink-0 text-ink-faint hover:text-red-600 transition opacity-60 group-hover/al:opacity-100"
                          title="Remove alias" aria-label="Remove alias"
                          onPointerDown={(e) => e.stopPropagation()} onClick={() => ops.deleteAlias(ckey, i)}>×</button>
                </div>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); submitAlias(); }} className="flex gap-1 pt-0.5">
                <input className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md border border-line bg-paper-card text-xs focus:outline-none focus:border-accent-ring"
                       placeholder="add an alias…" value={aliasDraft} onPointerDown={(e) => e.stopPropagation()}
                       onChange={(e) => { setAliasDraft(e.target.value); setAliasErr(""); }} />
                <button type="submit" disabled={!aliasDraft.trim()}
                        className="shrink-0 px-2 py-0.5 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent-hover transition disabled:opacity-50">Add</button>
              </form>
              {aliasErr && <p className="text-red-600">{aliasErr}</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {/* dot points — added via a toggled inline form, exactly like the relationships section below */}
        <div className="px-3 pt-2 pb-2">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex-1">Dot points</span>
            <button className="text-xs text-accent-hover hover:underline" onClick={() => setNoteOpen((v) => !v)}>{noteOpen ? "Cancel" : "+ Add dot point"}</button>
          </div>
          <ul className="space-y-1.5 text-sm">
            {(ctx.points || []).map((p, i) => (
              <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                         onSave={(t) => onEditPoint(ckey, pointRef(p, i), t)}
                         onDelete={() => ops.deletePoint(ckey, pointRef(p, i))} />
            ))}
            {(!ctx.points || ctx.points.length === 0) && !noteOpen && <li className="text-ink-faint italic">no dot points yet</li>}
          </ul>
          {noteOpen && (
            <div className="mt-2 flex gap-1.5">
              <input autoFocus className="flex-1 px-2 py-1 rounded-md border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring"
                     placeholder="dot point text…" value={note} onPointerDown={(e) => e.stopPropagation()}
                     onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitNote()} />
              <button className="px-2.5 py-1 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition disabled:opacity-50"
                      disabled={!note.trim()} onClick={submitNote}>Add</button>
            </div>
          )}
        </div>

        {/* relationships */}
        <div className="px-3 pb-2 pt-1 border-t border-line">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex-1">Relationships</span>
            <button className="text-xs text-accent-hover hover:underline" onClick={() => setLinkOpen((v) => !v)}>{linkOpen ? "Cancel" : "+ Add relationship"}</button>
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
                  <button className="group/trash shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete relationship" aria-label="Delete relationship" onClick={() => ops.deleteLink(r.id)}>
                    <TrashImg className="w-3.5 h-3.5" />
                  </button>
                </li>
              );
            })}
            {links.length === 0 && !linkOpen && <li className="text-ink-faint italic">no relationships yet</li>}
          </ul>

          {linkOpen && (
            <div className="mt-2 flex flex-col gap-1.5">
              <select value={target} onChange={(e) => setTarget(e.target.value)}
                      className="text-sm bg-paper-card border border-line rounded-md px-1.5 py-1 focus:outline-none focus:border-accent-ring">
                <option value="">Relate to…</option>
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
                        disabled={!target} onClick={create}>Add</button>
              </div>
            </div>
          )}
        </div>
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
  const [noteOpen, setNoteOpen] = useState(false); //toggle the add-dot-point form
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

      {/* dot points — added via a toggled inline form, the same style as adding a relationship */}
      <div className="flex-1 overflow-auto px-3 pt-2 pb-2">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex-1">Dot points</span>
          <button className="text-xs text-accent-hover hover:underline" onClick={() => setNoteOpen((v) => !v)}>{noteOpen ? "Cancel" : "+ Add dot point"}</button>
        </div>
        <ul className="space-y-1.5 text-sm">
          {(rel.points || []).map((p, i) => (
            <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                       onSave={(t) => ops.editRelPoint(rel.id, pointRef(p, i), t)}
                       onDelete={() => ops.deleteRelPoint(rel.id, pointRef(p, i))} />
          ))}
          {(!rel.points || rel.points.length === 0) && !noteOpen && <li className="text-ink-faint italic">no dot points on this relationship</li>}
        </ul>
        {noteOpen && (
          <div className="mt-2 flex gap-1.5">
            <input autoFocus className="flex-1 px-2 py-1 rounded-md border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring"
                   placeholder="dot point text…" value={note}
                   onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitNote()} />
            <button className="px-2.5 py-1 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition disabled:opacity-50"
                    disabled={!note.trim()} onClick={submitNote}>Add</button>
          </div>
        )}
      </div>

      {confirmDel ? (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-line text-sm">
          <span className="flex-1">Delete this relationship?</span>
          <button className="text-red-600 font-semibold hover:underline" onClick={() => ops.deleteLink(rel.id)}>Delete</button>
          <button className="text-ink-soft hover:text-ink" onClick={() => setConfirmDel(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex justify-end p-2 border-t border-line bg-paper">
          <button className="group/trash px-2 py-1.5 rounded-lg border border-line hover:bg-paper-sunk transition" title="Delete relationship" aria-label="Delete relationship" onClick={() => setConfirmDel(true)}>
            <TrashImg className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
