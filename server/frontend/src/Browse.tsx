import { useState } from "react";
import { pointText, pointProgress, contextProgress, colorFor, typeLabel, TYPE_LABELS } from "./model";
import { btnAccent, input } from "./ui";
import type { Doc, Selected } from "./types";

const BUILTIN_ORDER = ["character", "place", "object", "concept"];

const CUSTOM = "__custom__";  //sentinel in the type picker for "make a new type"

//grouped list of contexts + notes (mirrors the device). respects the shared type filter and dims
//entries that haven't been reached at the current scrub point.
export default function Browse({ doc, scrub, selected, onSelect, onAddContext, onAddRelationship, canAdd, hiddenTypes, typeColors }: {
  doc: Doc; scrub: number; selected: Selected; hiddenTypes: Set<string>; typeColors: Record<string, string>;
  onSelect: (s: Selected) => void; onAddContext: (title: string, type: string) => void;
  onAddRelationship: (from: string, to: string, label: string, directed: boolean) => void;
  canAdd: boolean;  //false when the book has no timeline yet — additions are hidden (nowhere to anchor them)
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("unset");
  const [customType, setCustomType] = useState("");  //free-text type name when type === CUSTOM
  const [relFrom, setRelFrom] = useState("");
  const [relTo, setRelTo] = useState("");
  const [relLabel, setRelLabel] = useState("");
  const [relDirected, setRelDirected] = useState(true);
  const contexts = doc.contexts || {};

  const buckets: Record<string, string[]> = {};
  for (const k in contexts) {
    const t = contexts[k].type || "unset";
    (buckets[t] = buckets[t] || []).push(k);
  }
  const customTypes = Object.keys(buckets).filter((t) => t !== "unset" && !TYPE_LABELS[t]).sort();
  const sections: [string, string][] = [
    ...BUILTIN_ORDER.map((t): [string, string] => [t, TYPE_LABELS[t]]),
    ...customTypes.map((t): [string, string] => [t, t + " (custom)"]),
    ["unset", "No type"],
  ];

  //contexts as link endpoints, by title
  const ctxOptions = Object.keys(contexts)
    .map((k) => ({ k, title: contexts[k].title || k }))
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const addContext = () => {
    if (!title.trim()) return;
    let t = type;
    if (type === CUSTOM) { t = customType.trim().toLowerCase(); if (!t) return; }  //need a name for a new type
    onAddContext(title.trim(), t);
    setTitle("");
  };
  const addRel = () => {
    if (!relFrom || !relTo || relFrom === relTo) return;
    onAddRelationship(relFrom, relTo, relLabel.trim(), relDirected);
    setRelLabel("");
  };

  return (
    <div className="pb-4">
      {canAdd && (
      <div className="flex flex-col gap-2 mb-4 sticky top-0 bg-paper py-1 z-10">
        {/* add a context (with an optional brand-new custom type) */}
        <div className="flex gap-2 flex-wrap items-center">
          <input className={`${input} w-56`} placeholder="new context name" value={title}
                 onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addContext()} />
          <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="unset">No type</option>
            {BUILTIN_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            {customTypes.map((t) => <option key={t} value={t}>{t} (custom)</option>)}
            <option value={CUSTOM}>+ New type…</option>
          </select>
          {type === CUSTOM && (
            <input className={`${input} w-32`} placeholder="type name" value={customType} autoFocus
                   onChange={(e) => setCustomType(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addContext()} />
          )}
          <button className={btnAccent} onClick={addContext}>Add context</button>
        </div>

        {/* link two contexts with a relationship */}
        {ctxOptions.length >= 2 && (
          <div className="flex gap-2 flex-wrap items-center">
            <select className={input} value={relFrom} onChange={(e) => setRelFrom(e.target.value)}>
              <option value="">link from…</option>
              {ctxOptions.map((o) => <option key={o.k} value={o.k}>{o.title}</option>)}
            </select>
            <span className="text-ink-faint select-none">{relDirected ? "→" : "—"}</span>
            <select className={input} value={relTo} onChange={(e) => setRelTo(e.target.value)}>
              <option value="">to…</option>
              {ctxOptions.map((o) => <option key={o.k} value={o.k}>{o.title}</option>)}
            </select>
            <input className={`${input} flex-1 min-w-[120px]`} placeholder="label (optional)" value={relLabel}
                   onChange={(e) => setRelLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addRel()} />
            <label className="flex items-center gap-1.5 text-sm text-ink-soft cursor-pointer select-none">
              <input type="checkbox" className="h-4 w-4 accent-accent cursor-pointer" checked={relDirected}
                     onChange={(e) => setRelDirected(e.target.checked)} />
              directed
            </label>
            <button className={btnAccent} onClick={addRel} disabled={!relFrom || !relTo || relFrom === relTo}>Add link</button>
          </div>
        )}

        {/* everything added here is pinned to where the timeline is scrubbed to */}
        <p className="text-xs text-ink-faint">
          New contexts, links and notes are pinned to the current timeline position — scrub the timeline to the right spot first.
        </p>
      </div>
      )}

      {sections.map(([t, label]) => {
        if (hiddenTypes.has(t)) return null;
        const keys = (buckets[t] || []).sort((a, b) =>
          (contexts[a].title || a).toLowerCase().localeCompare((contexts[b].title || b).toLowerCase()));
        if (keys.length === 0) return null;
        return (
          <div key={t} className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: colorFor(t, typeColors) }} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</span>
              <span className="text-xs text-ink-faint tabular-nums">{keys.length}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {keys.map((k) => {
                const c = contexts[k];
                const cp = contextProgress(c);
                const dim = cp != null && cp > scrub;
                const sel = selected?.kind === "context" && selected.id === k;
                return (
                  <button key={k} onClick={() => onSelect({ kind: "context", id: k })}
                          className={`text-left rounded-xl border bg-paper-card p-3 shadow-card transition hover:shadow-pop hover:-translate-y-0.5 ${
                            dim ? "opacity-50" : ""} ${sel ? "border-accent ring-2 ring-accent/30" : "border-line"}`}>
                    <strong className="block truncate">{c.title}</strong>
                    {(c.aliases?.length ?? 0) > 0 && (
                      <span className="block truncate text-xs text-ink-faint">aka {c.aliases!.join(", ")}</span>
                    )}
                    <ul className="mt-1.5 space-y-1 text-sm text-ink-soft">
                      {(c.points || []).slice(0, 4).map((p, i) => {
                        const pr = pointProgress(p);
                        return <li key={i} className={`flex gap-1.5 ${pr != null && pr > scrub ? "opacity-40" : ""}`}>
                          <span className="text-accent select-none">•</span><span className="truncate">{pointText(p)}</span></li>;
                      })}
                      {(c.points?.length || 0) > 4 && <li className="text-xs text-ink-faint pl-3.5">+{(c.points!.length - 4)} more</li>}
                      {(!c.points || c.points.length === 0) && <li className="text-xs text-ink-faint italic">no notes yet</li>}
                    </ul>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
