import { card } from "./ui";
import type { Doc, TocEntry } from "./types";

//narrative-progress scrubber (0..1 through the book). the bar fills up to the scrub point
//(before = shown, after = hidden), chapter boundaries are faint ticks, the current chapter is
//highlighted, and a single caption reads "<chapter> · NN%".
export default function Timeline({ doc, scrub, onScrub }: {
  doc: Doc; scrub: number; onScrub: (v: number) => void;
}) {
  const toc: TocEntry[] = (doc.book?.toc || [])
    .map((c) => ({ title: c.title, progress: Math.max(0, Math.min(1, c.progress || 0)) }))
    .sort((a, b) => a.progress - b.progress);

  let cur = -1;
  for (let i = 0; i < toc.length; i++) {
    if (toc[i].progress <= scrub) cur = i; else break;
  }
  const curChapter = cur >= 0 ? toc[cur] : null;
  const curStart = curChapter ? curChapter.progress : 0;
  const curEnd = cur >= 0 && cur + 1 < toc.length ? toc[cur + 1].progress : 1;
  const pct = Math.round(scrub * 100);
  const caption = curChapter ? curChapter.title : toc.length ? "Before " + toc[0].title : "Whole book";

  return (
    <div className={`${card} my-3`}>
      <div className="relative h-[18px] bg-gray-200 border border-gray-300 rounded overflow-hidden">
        {curChapter && (
          <div className="absolute top-0 bottom-0 bg-blue-500/10 border-x border-blue-600"
               style={{ left: curStart * 100 + "%", width: (curEnd - curStart) * 100 + "%" }} />
        )}
        <div className="absolute left-0 top-0 bottom-0 bg-blue-500/40" style={{ width: scrub * 100 + "%" }} />
        {toc.map((c, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-gray-400" style={{ left: c.progress * 100 + "%" }} />
        ))}
      </div>
      <input type="range" min={0} max={1} step={0.005} value={scrub} className="w-full mt-1.5"
             onChange={(e) => onScrub(parseFloat(e.target.value))} />
      <div className="flex items-center gap-2 text-sm">
        <strong>{caption}</strong>
        <span className="text-gray-500">· {pct}% through the book</span>
        <span className="flex-1" />
        <button className="px-2 py-1 border border-gray-300 rounded-md hover:bg-gray-100" onClick={() => onScrub(1)}>
          Show all
        </button>
      </div>
    </div>
  );
}
