import { useState } from "react";
import { pointText, pointProgress, typeLabel, colorFor, relArrow } from "../lib/model";
import PointItem from "./PointItem";
import type { Doc, GraphEditOps, Point, Selected } from "../lib/types";

const pointRef = (p: Point, i: number) => ({ id: typeof p === "object" ? p.id : undefined, index: i });

//side panel for the browse view: notes for the selected context (with an add box) or relationship.
export default function DetailPanel({ doc, selected, scrub, typeColors, ops, onAddPoint, onEditPoint, onClose }: {
  doc: Doc; selected: Selected; scrub: number; typeColors: Record<string, string>; ops: GraphEditOps;
  onAddPoint: (key: string, text: string) => void;
  onEditPoint: (key: string, ref: { id?: string; index: number }, text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasErr, setAliasErr] = useState("");
  const shell = "rounded-xl border border-line bg-paper-card shadow-card";

  if (!selected) {
    return <div className={`${shell} p-4 text-ink-faint text-sm`}>Select a context to read its notes.</div>;
  }

  if (selected.kind === "context") {
    const ctx = doc.contexts[selected.id];
    if (!ctx) return <div className={`${shell} p-4 text-ink-faint text-sm`}>(no longer here)</div>;
    const submit = () => { if (text.trim()) { onAddPoint(selected.id, text.trim()); setText(""); } };
    const submitAlias = () => {
      const t = aliasDraft.trim();
      if (!t) return;
      const err = ops.addAlias(selected.id, t);
      if (err) { setAliasErr(err); return; }
      setAliasDraft(""); setAliasErr("");
    };
    return (
      <div className={`${shell} overflow-hidden`}>
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorFor(ctx.type, typeColors) }} />
          <strong className="min-w-0 flex-1 truncate">{ctx.title}</strong>
          {typeLabel(ctx.type) && <span className="text-xs text-ink-faint shrink-0">{typeLabel(ctx.type)}</span>}
          <button className="text-ink-faint hover:text-ink transition text-lg leading-none shrink-0" onClick={onClose} aria-label="Close">×</button>
        </div>
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
                          title="Make this the main name" aria-label="Make main name" onClick={() => ops.promoteAlias(selected.id, i)}>↑</button>
                  <button className="shrink-0 text-ink-faint hover:text-red-600 transition opacity-60 group-hover/al:opacity-100"
                          title="Remove alias" aria-label="Remove alias" onClick={() => ops.deleteAlias(selected.id, i)}>×</button>
                </div>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); submitAlias(); }} className="flex gap-1 pt-0.5">
                <input className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md border border-line bg-paper-card text-xs focus:outline-none focus:border-accent-ring"
                       placeholder="add an alias…" value={aliasDraft}
                       onChange={(e) => { setAliasDraft(e.target.value); setAliasErr(""); }} />
                <button type="submit" disabled={!aliasDraft.trim()}
                        className="shrink-0 px-2 py-0.5 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent-hover transition disabled:opacity-50">Add</button>
              </form>
              {aliasErr && <p className="text-red-600">{aliasErr}</p>}
            </div>
          )}
        </div>
        <ul className="px-4 py-3 space-y-1.5 text-sm">
          {(ctx.points || []).map((p, i) => (
            <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                       onSave={(t) => onEditPoint(selected.id, pointRef(p, i), t)} />
          ))}
          {(!ctx.points || ctx.points.length === 0) && <li className="text-ink-faint italic">no notes yet</li>}
        </ul>
        <div className="flex gap-1.5 p-2 border-t border-line bg-paper">
          <input className="flex-1 px-2.5 py-1.5 rounded-lg border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring focus:ring-2 focus:ring-accent-ring/30"
                 placeholder="add a note…" value={text}
                 onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition" onClick={submit}>Add</button>
        </div>
      </div>
    );
  }

  const rel = (doc.relationships || []).find((r) => r.id === selected.id);
  if (!rel) return <div className={`${shell} p-4 text-ink-faint text-sm`}>(no longer here)</div>;
  const fromTitle = doc.contexts[rel.from]?.title || rel.from;
  const toTitle = doc.contexts[rel.to]?.title || rel.to;
  return (
    <div className={`${shell} overflow-hidden`}>
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
        <strong className="truncate text-sm">{fromTitle} {relArrow(rel)} {toTitle}</strong>
        <span className="flex-1" />
        <button className="text-ink-faint hover:text-ink transition text-lg leading-none" onClick={onClose} aria-label="Close">×</button>
      </div>
      {rel.label && <p className="px-4 pt-2 text-sm font-medium text-accent-hover">{rel.label}</p>}
      <ul className="px-4 py-3 space-y-1.5 text-sm">
        {(rel.points || []).map((p, i) => <li key={i} className="flex gap-1.5"><span className="text-accent select-none">•</span><span>{pointText(p)}</span></li>)}
        {(!rel.points || rel.points.length === 0) && <li className="text-ink-faint italic">no notes on this link</li>}
      </ul>
    </div>
  );
}
