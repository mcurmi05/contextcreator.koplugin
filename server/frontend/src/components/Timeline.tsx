import { useEffect, useRef, useState } from "react";
import { btn, btnAccent, btnGhost } from "../lib/ui";
import type { DevicePosition, Doc, TocEntry } from "../lib/types";

//a place "jump to current" can send the scrubber: a koreader device's last-read spot. when no device has
//reported yet we fall back to the doc's single shared reading_progress as one unnamed target.
interface JumpTarget { id: string; name: string | null; rp: number; updated: number; }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

//short "how long ago this device last synced" hint, so the user can tell which device is actually live
function ago(updated: number): string {
  if (!updated) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - updated);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

//narrative-progress scrubber (0..1 through the book). the filled portion is "what's happened so far";
//chapter boundaries are faint ticks, the current chapter is banded, and the caption reads "<chapter> · NN%".
export default function Timeline({ doc, devices = [], external = false, scrub, onScrub, onAddContext, onAddRelationship }: {
  doc: Doc; devices?: DevicePosition[]; external?: boolean; scrub: number; onScrub: (v: number) => void;
  onAddContext?: () => void;       //when set, show an accent "Add context" button (graph view)
  onAddRelationship?: () => void;  //when set, show an "Add relationship" button next to it
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toc: TocEntry[] = (doc.book?.toc || [])
    .map((c) => ({ title: c.title, progress: clamp01(c.progress || 0) }))
    .sort((a, b) => a.progress - b.progress);

  let cur = -1;
  for (let i = 0; i < toc.length; i++) { if (toc[i].progress <= scrub) cur = i; else break; }
  const curChapter = cur >= 0 ? toc[cur] : null;
  const curStart = curChapter ? curChapter.progress : 0;
  const curEnd = cur >= 0 && cur + 1 < toc.length ? toc[cur + 1].progress : 1;
  const pct = Math.round(scrub * 100);

  //once you've scrubbed to the tail end of a chapter (within NEXT_CHAPTER_AT of its span), name the
  //chapter you're about to enter instead — e.g. at 99% through ch18 the caption reads ch19.
  const NEXT_CHAPTER_AT = 0.99;
  let nameIdx = cur;
  if (cur >= 0 && cur + 1 < toc.length && curEnd > curStart
      && (scrub - curStart) / (curEnd - curStart) >= NEXT_CHAPTER_AT) {
    nameIdx = cur + 1;
  }
  const caption = nameIdx >= 0 ? toc[nameIdx].title : toc.length ? "Before " + toc[0].title : "Whole book";

  //place a device on THIS timeline. the raw reading_progress is render-dependent, so a device drifts
  //(by whole chapters) against a timeline another device built. when the device told us which chapter
  //it's in, re-anchor by chapter (logical, identical across devices) + fraction through it; otherwise
  //fall back to the raw fraction.
  function deviceRp(d: DevicePosition): number {
    if (d.chapter && typeof d.chapter_frac === "number" && toc.length) {
      //some books reuse a chapter title at several spots (e.g. "Jon" in Game of Thrones), so don't just
      //take the first match — pick the occurrence nearest the raw reading position. the raw fraction
      //drifts only slightly, far less than the gap between two same-named chapters, so it reliably tells
      //which one the device is actually in.
      const rp = clamp01(d.reading_progress);
      let best = -1, bestDist = Infinity;
      for (let i = 0; i < toc.length; i++) {
        if (toc[i].title !== d.chapter) continue;
        const start = toc[i].progress;
        const end = i + 1 < toc.length ? toc[i + 1].progress : 1;
        const dist = rp < start ? start - rp : rp > end ? rp - end : 0; //distance from rp to [start,end]
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      if (best >= 0) {
        const start = toc[best].progress;
        const end = best + 1 < toc.length ? toc[best + 1].progress : 1;
        return clamp01(start + d.chapter_frac * Math.max(0, end - start));
      }
    }
    return clamp01(d.reading_progress);
  }

  //one jump target per connected device (freshest first, as the server returns them). if none have
  //synced a position, fall back to the doc's single shared reading position. imported (external) files
  //aren't tied to any device/book, so there's nothing to "jump to current" for — skip targets entirely.
  const targets: JumpTarget[] = external ? [] : devices
    .filter((d) => typeof d.reading_progress === "number")
    .map((d) => ({ id: d.device_id, name: d.device_name || "KOReader", rp: deviceRp(d), updated: d.updated }));
  if (!external && !targets.length && typeof doc.reading_progress === "number") {
    targets.push({ id: "_doc", name: null, rp: clamp01(doc.reading_progress), updated: 0 });
  }

  return (
    <div className="rounded-xl border border-line bg-paper-card shadow-card px-4 py-3">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Timeline</span>
        <strong className="text-sm truncate">{caption}</strong>
        <span className="text-sm text-ink-faint tabular-nums">· {pct}%</span>
        <span className="flex-1" />

        {onAddContext && (
          <button className={btnAccent} onClick={onAddContext} title="Add a new context at the current timeline point">
            Add context
          </button>
        )}
        {onAddRelationship && (
          <button className={btn} onClick={onAddRelationship} title="Link two contexts with a relationship">
            Add relationship
          </button>
        )}

        {/* one device -> a plain "jump to current"; several -> a picker so you can choose which device */}
        {targets.length === 1 && (
          <button className={btnGhost} onClick={() => onScrub(targets[0].rp)} disabled={Math.abs(scrub - targets[0].rp) < 0.005}
                  title={targets[0].name
                    ? `Jump to where ${targets[0].name} has read to (${Math.round(targets[0].rp * 100)}%)`
                    : `Jump to where you've read to (${Math.round(targets[0].rp * 100)}%)`}>
            Jump to current
          </button>
        )}
        {targets.length > 1 && (
          <div className="relative self-center" ref={ref}>
            <button className={btnGhost} onClick={() => setOpen((o) => !o)} aria-expanded={open}
                    title="Jump to where one of your devices has read to">
              Jump to current <span className="text-ink-faint text-xs">▾</span>
            </button>
            {open && (
              <div className="absolute right-0 z-40 mt-1 w-60 rounded-xl border border-line bg-paper-card shadow-card p-1.5">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Devices</div>
                <div className="flex flex-col gap-0.5 max-h-72 overflow-auto">
                  {targets.map((t) => (
                    <button key={t.id} onClick={() => { onScrub(t.rp); setOpen(false); }}
                            className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-left text-ink-soft hover:bg-paper-sunk hover:text-ink transition">
                      <span className="flex-1 min-w-0 truncate">{t.name}</span>
                      <span className="shrink-0 tabular-nums text-ink">{Math.round(t.rp * 100)}%</span>
                      {t.updated > 0 && <span className="shrink-0 text-[11px] text-ink-faint">{ago(t.updated)}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <button className={btnGhost} onClick={() => onScrub(1)} disabled={scrub >= 1}>Show all</button>
      </div>

      <div className="relative pt-3">
        {/* arrow pointing down at the block of the chapter you're currently in */}
        {curChapter && (
          <div className="absolute top-0 -translate-x-1/2 leading-none text-[11px] text-scrub select-none"
               style={{ left: ((curStart + curEnd) / 2) * 100 + "%" }} aria-hidden="true">▼</div>
        )}
        <div className="relative h-2.5 rounded-full bg-paper-sunk border border-line overflow-hidden">
          {/* band for the current chapter */}
          {curChapter && (
            <div className="absolute top-0 bottom-0 bg-scrub/10 border-x border-scrub/40"
                 style={{ left: curStart * 100 + "%", width: (curEnd - curStart) * 100 + "%" }} />
          )}
          {/* "so far" fill — square inner (right) edge; the track's rounding + clip keeps the far ends round */}
          <div className="absolute left-0 top-0 bottom-0 bg-scrub/55" style={{ width: scrub * 100 + "%" }} />
          {/* chapter boundary ticks */}
          {toc.map((c, i) => (
            <div key={i} className="absolute top-0 bottom-0 w-px bg-line-strong" style={{ left: c.progress * 100 + "%" }} />
          ))}
          {/* a marker per device's last-read point */}
          {targets.map((t) => (
            <div key={t.id} className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-ink rounded-full"
                 style={{ left: t.rp * 100 + "%" }}
                 title={t.name ? `${t.name} has read to ${Math.round(t.rp * 100)}%` : `You've read to ${Math.round(t.rp * 100)}%`} />
          ))}
        </div>
      </div>

      <input type="range" min={0} max={1} step={0.005} value={scrub} className="scrubber mt-2"
             aria-label="Story progress" onChange={(e) => onScrub(parseFloat(e.target.value))} />
    </div>
  );
}
