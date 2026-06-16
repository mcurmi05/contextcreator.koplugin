import { btnGhost } from "./ui";
import type { Doc, TocEntry } from "./types";

//narrative-progress scrubber (0..1 through the book). the filled portion is "what's happened so far";
//chapter boundaries are faint ticks, the current chapter is banded, and the caption reads "<chapter> · NN%".
export default function Timeline({ doc, scrub, onScrub }: {
  doc: Doc; scrub: number; onScrub: (v: number) => void;
}) {
  const toc: TocEntry[] = (doc.book?.toc || [])
    .map((c) => ({ title: c.title, progress: Math.max(0, Math.min(1, c.progress || 0)) }))
    .sort((a, b) => a.progress - b.progress);

  let cur = -1;
  for (let i = 0; i < toc.length; i++) { if (toc[i].progress <= scrub) cur = i; else break; }
  const curChapter = cur >= 0 ? toc[cur] : null;
  const curStart = curChapter ? curChapter.progress : 0;
  const curEnd = cur >= 0 && cur + 1 < toc.length ? toc[cur + 1].progress : 1;
  const pct = Math.round(scrub * 100);
  const caption = curChapter ? curChapter.title : toc.length ? "Before " + toc[0].title : "Whole book";

  return (
    <div className="rounded-xl border border-line bg-paper-card shadow-card px-4 py-3">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Timeline</span>
        <strong className="text-sm truncate">{caption}</strong>
        <span className="text-sm text-ink-faint tabular-nums">· {pct}%</span>
        <span className="flex-1" />
        <button className={btnGhost} onClick={() => onScrub(1)} disabled={scrub >= 1}>Show all</button>
      </div>

      <div className="relative h-2.5 rounded-full bg-paper-sunk border border-line overflow-hidden">
        {/* band for the current chapter */}
        {curChapter && (
          <div className="absolute top-0 bottom-0 bg-scrub/10 border-x border-scrub/40"
               style={{ left: curStart * 100 + "%", width: (curEnd - curStart) * 100 + "%" }} />
        )}
        {/* "so far" fill */}
        <div className="absolute left-0 top-0 bottom-0 bg-scrub/55 rounded-full" style={{ width: scrub * 100 + "%" }} />
        {/* chapter boundary ticks */}
        {toc.map((c, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-line-strong" style={{ left: c.progress * 100 + "%" }} />
        ))}
      </div>

      <input type="range" min={0} max={1} step={0.005} value={scrub} className="scrubber mt-2"
             aria-label="Story progress" onChange={(e) => onScrub(parseFloat(e.target.value))} />
    </div>
  );
}
