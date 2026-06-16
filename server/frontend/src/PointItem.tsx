import { useState } from "react";

//a single dot point. when editable, click the text to edit it inline (Enter saves, Esc cancels).
//when onDelete is given, a × appears on hover to remove the point.
export default function PointItem({ text, dim, editable, onSave, onDelete }: {
  text: string; dim?: boolean; editable?: boolean; onSave?: (t: string) => void; onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);

  function start() { if (!editable) return; setVal(text); setEditing(true); }
  function commit() {
    setEditing(false);
    const t = val.trim();
    if (t && t !== text) onSave?.(t);
  }

  return (
    <li className={`group flex gap-1.5 ${dim ? "opacity-40" : ""}`}>
      <span className="text-accent select-none leading-6">•</span>
      {editing ? (
        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
               className="flex-1 px-1.5 py-0.5 -my-0.5 rounded-md border border-accent-ring bg-paper-card text-sm focus:outline-none focus:ring-2 focus:ring-accent-ring/30" />
      ) : (
        <>
          <span onClick={start}
                className={`flex-1 ${editable ? "cursor-text rounded px-0.5 -mx-0.5 hover:bg-accent-soft transition" : ""}`}
                title={editable ? "click to edit" : undefined}>{text}</span>
          {onDelete && (
            <button onClick={onDelete} title="Delete dot point" aria-label="Delete dot point"
                    className="shrink-0 text-ink-faint hover:text-red-600 transition leading-6 opacity-0 group-hover:opacity-100">×</button>
          )}
        </>
      )}
    </li>
  );
}
