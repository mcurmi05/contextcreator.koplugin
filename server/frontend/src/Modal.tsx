import { useEffect } from "react";
import { btn, btnAccent, btnDanger } from "./ui";

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

//a styled confirm dialog (replaces window.confirm), matching the app surfaces. `danger` makes the
//confirm button red for destructive actions like deleting a profile.
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm, onCancel }: {
  title: string; message: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm text-ink-soft">{message}</div>
      <div className="flex justify-end gap-2 mt-4">
        <button className={btn} onClick={onCancel}>{cancelLabel}</button>
        <button className={danger ? btnDanger : btnAccent} onClick={onConfirm} autoFocus>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

//a styled info dialog (replaces window.alert): a message with a single OK button.
export function InfoDialog({ title, message, onClose }: {
  title: string; message: React.ReactNode; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-ink-soft">{message}</div>
      <div className="flex justify-end mt-4">
        <button className={btnAccent} onClick={onClose} autoFocus>OK</button>
      </div>
    </Modal>
  );
}
