//small shared Tailwind class strings, so components don't repeat long utility lists.
export const card = "rounded-xl border border-line bg-paper-card shadow-card";

//buttons: a quiet default, an amber primary, a borderless ghost. all 150ms transitions.
export const btn =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-paper-card text-ink " +
  "text-sm font-medium shadow-card hover:border-line-strong hover:bg-paper-sunk active:scale-[0.98] " +
  "transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-paper";
export const btnAccent =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-semibold " +
  "shadow-card hover:bg-accent-hover active:scale-[0.98] transition disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1";
export const btnDanger =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-semibold " +
  "shadow-card hover:bg-red-700 active:scale-[0.98] transition disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1";
export const btnGhost =
  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-ink-soft text-sm font-medium " +
  "hover:bg-paper-sunk hover:text-ink active:scale-[0.98] transition focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent-ring";
export const input =
  "px-3 py-2 rounded-lg border border-line bg-paper-card text-sm text-ink placeholder:text-ink-faint " +
  "focus:outline-none focus:border-accent-ring focus:ring-2 focus:ring-accent-ring/30 transition";
