import { useEffect } from "react";

//a small centred modal matching the app's surfaces (same backdrop/animation as the Settings dialog).
//closes on Escape or a backdrop click. used for the graph's "Add context" / "Add relationship" inputs
//instead of the browser's window.prompt.
export default function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40 animate-fadein" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-line bg-paper-card shadow-pop animate-pop p-5"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <strong className="text-base">{title}</strong>
          <span className="flex-1" />
          <button className="text-ink-faint hover:text-ink transition text-2xl leading-none" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
