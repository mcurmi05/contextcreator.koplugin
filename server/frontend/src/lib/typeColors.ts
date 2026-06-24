//per-type node colour overrides, persisted in the browser (localStorage). keyed by type name so the
//same type shares a colour across books. purely a display preference, never synced.
const KEY = "cc-type-colors";

export function loadTypeColors(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch { return {}; }
}

export function saveTypeColors(map: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* ignore quota/availability */ }
}
