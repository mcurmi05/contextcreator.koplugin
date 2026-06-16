import { useState } from "react";
import { pointText, pointProgress, contextProgress, colorFor, typeLabel, TYPE_LABELS } from "./model";
import { btnAccent, input } from "./ui";
import type { Doc, Selected } from "./types";

const BUILTIN_ORDER = ["character", "place", "object", "concept"];

//grouped list of contexts + notes (mirrors the device). respects the shared type filter and dims
//entries that haven't been reached at the current scrub point.
export default function Browse({ doc, scrub, selected, onSelect, onAddContext, hiddenTypes, typeColors }: {
  doc: Doc; scrub: number; selected: Selected; hiddenTypes: Set<string>; typeColors: Record<string, string>;
  onSelect: (s: Selected) => void; onAddContext: (title: string, type: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("unset");
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

  const addContext = () => { if (title.trim()) { onAddContext(title.trim(), type); setTitle(""); } };

  return (
    <div className="pb-4">
      <div className="flex gap-2 flex-wrap mb-4 sticky top-0 bg-paper py-1 z-10">
        <input className={`${input} flex-1 min-w-[160px]`} placeholder="new context name" value={title}
               onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addContext()} />
        <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="unset">No type</option>
          {BUILTIN_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
        <button className={btnAccent} onClick={addContext}>Add context</button>
      </div>

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
