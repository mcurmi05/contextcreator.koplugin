import { useState } from "react";
import { pointText, pointProgress, typeLabel, relArrow } from "./model";
import { card, btn, input } from "./ui";
import type { Doc, Selected } from "./types";

//shows the dot points for the selected context or relationship; for a context you can add one.
export default function DetailPanel({ doc, selected, scrub, onAddPoint, onClose }: {
  doc: Doc; selected: Selected; scrub: number;
  onAddPoint: (key: string, text: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState("");

  if (!selected) {
    return <div className={`${card} w-[300px] shrink-0 text-gray-500`}>Select a context or relationship to read its notes.</div>;
  }

  if (selected.kind === "context") {
    const ctx = doc.contexts[selected.id];
    if (!ctx) return <div className={`${card} w-[300px] shrink-0 text-gray-500`}>(no longer here)</div>;
    const submit = () => { if (text.trim()) { onAddPoint(selected.id, text.trim()); setText(""); } };
    return (
      <div className={`${card} w-[300px] shrink-0`}>
        <div className="flex items-center gap-2">
          <strong>{ctx.title}</strong>
          <span className="text-gray-500 text-sm">{typeLabel(ctx.type)}</span>
          <span className="flex-1" />
          <button className={btn} onClick={onClose}>×</button>
        </div>
        <ul className="list-disc pl-5 my-2 text-sm">
          {(ctx.points || []).map((p, i) => {
            const pr = pointProgress(p);
            return <li key={i} className={pr != null && pr > scrub ? "opacity-50" : ""}>{pointText(p)}</li>;
          })}
          {(!ctx.points || ctx.points.length === 0) && <li className="text-gray-400 list-none">no dot points</li>}
        </ul>
        <div className="flex gap-2">
          <input className={`${input} flex-1`} placeholder="add a dot point" value={text}
                 onChange={(e) => setText(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className={btn} onClick={submit}>Add</button>
        </div>
      </div>
    );
  }

  const rel = (doc.relationships || []).find((r) => r.id === selected.id);
  if (!rel) return <div className={`${card} w-[300px] shrink-0 text-gray-500`}>(no longer here)</div>;
  const fromTitle = doc.contexts[rel.from]?.title || rel.from;
  const toTitle = doc.contexts[rel.to]?.title || rel.to;
  return (
    <div className={`${card} w-[300px] shrink-0`}>
      <div className="flex items-center gap-2">
        <strong>{fromTitle} {relArrow(rel)} {toTitle}</strong>
        <span className="flex-1" />
        <button className={btn} onClick={onClose}>×</button>
      </div>
      <p className="text-gray-500 text-sm">{rel.label}</p>
      <ul className="list-disc pl-5 my-2 text-sm">
        {(rel.points || []).map((p, i) => <li key={i}>{pointText(p)}</li>)}
        {(!rel.points || rel.points.length === 0) && <li className="text-gray-400 list-none">no dot points</li>}
      </ul>
    </div>
  );
}
