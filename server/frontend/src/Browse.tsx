import { useState } from "react";
import { pointText, pointProgress, contextProgress, TYPE_LABELS } from "./model";
import { btn, input } from "./ui";
import type { Doc, Selected } from "./types";

const BUILTIN_ORDER = ["character", "place", "object", "concept"];

//grouped list of contexts + dot points (mirrors the device). dims entries past the scrub point.
export default function Browse({ doc, scrub, selected, onSelect, onAddContext }: {
  doc: Doc; scrub: number; selected: Selected;
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
    <div>
      <div className="flex gap-2 flex-wrap mb-2">
        <input className={input} placeholder="new context name" value={title}
               onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addContext()} />
        <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="unset">No type</option>
          {BUILTIN_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
        <button className={btn} onClick={addContext}>Add context</button>
      </div>

      {sections.map(([t, label]) => {
        const keys = (buckets[t] || []).sort((a, b) =>
          (contexts[a].title || a).toLowerCase().localeCompare((contexts[b].title || b).toLowerCase()));
        if (keys.length === 0) return null;
        return (
          <div key={t}>
            <div className="font-semibold mt-3 mb-1">{label}</div>
            {keys.map((k) => {
              const c = contexts[k];
              const cp = contextProgress(c);
              const dim = cp != null && cp > scrub;
              const sel = selected?.kind === "context" && selected.id === k;
              return (
                <div key={k}
                     className={`border rounded-lg p-2.5 my-2 cursor-pointer ${dim ? "opacity-50" : ""} ${sel ? "border-blue-600 ring-1 ring-blue-600" : "border-gray-200"}`}
                     onClick={() => onSelect({ kind: "context", id: k })}>
                  <strong>{c.title}</strong>
                  <ul className="list-disc pl-5 my-1 text-sm">
                    {(c.points || []).map((p, i) => {
                      const pr = pointProgress(p);
                      return <li key={i} className={pr != null && pr > scrub ? "opacity-50" : ""}>{pointText(p)}</li>;
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
