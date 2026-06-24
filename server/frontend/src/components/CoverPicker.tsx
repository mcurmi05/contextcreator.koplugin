import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { imageFileToCoverDataUrl } from "../lib/files";
import { btn } from "../lib/ui";
import Modal from "./Modal";

//pick which cover to show for a book: one per device that has synced (e.g. a grayscale e-ink Kobo vs a
//colour screen), plus any number of custom uploads. the book keeps whatever it was first synced to until
//the user picks another. opened from the cover thumbnail on the home page.
interface CoverOption { source: string; label: string; cover: string; custom: boolean }
interface CoversResp { covers: CoverOption[]; current: string | null }

const PLACEHOLDER = "/placeholder.jpg";

export default function CoverPicker({ bookId, title, onClose, onChanged }: {
  bookId: string; title?: string; onClose: () => void; onChanged: (cover: string) => void;
}) {
  const [data, setData] = useState<CoversResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () =>
    api<CoversResp>(`/api/books/${encodeURIComponent(bookId)}/covers`)
      .then(setData)
      .catch(() => setData({ covers: [], current: null }));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [bookId]);

  async function run(fn: () => Promise<{ cover: string }>) {
    setBusy(true); setErr("");
    try { const r = await fn(); onChanged(r.cover); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const choose = (source: string) =>
    run(() => api(`/api/books/${encodeURIComponent(bookId)}/cover`, { method: "PUT", body: JSON.stringify({ source }) }));
  const removeCustom = (source: string) =>
    run(() => api(`/api/books/${encodeURIComponent(bookId)}/cover/custom/${encodeURIComponent(source)}`, { method: "DELETE" }));
  async function upload(file: File) {
    setErr("");
    let durl: string;
    try { durl = await imageFileToCoverDataUrl(file); }
    catch (e) { setErr((e as Error).message); return; }
    await run(() => api(`/api/books/${encodeURIComponent(bookId)}/cover/custom`, { method: "POST", body: JSON.stringify({ cover: durl }) }));
  }

  const covers = data?.covers || [];
  const current = data?.current ?? null;

  return (
    <Modal title="Cover" onClose={onClose} maxWidth="max-w-md">
      <p className="text-sm text-ink-soft mb-3">
        Choose which cover to show{title ? <> for <strong>“{title}”</strong></> : null}. Each device that has synced
        provides its own, pick one, or upload your own.
      </p>
      {!data ? (
        <p className="text-ink-faint text-sm">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 max-h-[46vh] overflow-auto p-0.5">
            {covers.map((c) => (
              <div key={c.source} className="relative">
                <button onClick={() => choose(c.source)} disabled={busy}
                        className={`w-full flex flex-col items-center gap-1 rounded-lg p-1.5 border-2 transition disabled:opacity-50 ${
                          c.source === current ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-paper-sunk"}`}>
                  <img src={c.cover || PLACEHOLDER} alt="" className="w-16 h-24 rounded object-cover border border-line bg-paper-sunk" />
                  <span className="text-[11px] text-ink-soft text-center leading-tight truncate w-full">{c.label}</span>
                </button>
                {c.custom && (
                  <button onClick={() => removeCustom(c.source)} disabled={busy} title="Remove this cover" aria-label="Remove custom cover"
                          className="absolute top-1 right-1 grid place-items-center w-5 h-5 rounded-full bg-paper-card/90 border border-line text-ink-faint hover:text-red-600 shadow-card text-sm leading-none">
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          {covers.length === 0 && (
            <p className="text-xs text-ink-faint mt-2">No synced covers yet, they appear here as your devices sync. You can upload one now.</p>
          )}
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
          <div className="flex items-center gap-2 mt-4 whitespace-nowrap">
            <label className={`${btn} cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
              Upload custom…
              <input type="file" accept="image/*" className="hidden"
                     onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            </label>
            <span className="flex-1" />
            <button className={btn} onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
