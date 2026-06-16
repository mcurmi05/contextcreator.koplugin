//runtime UI theming, persisted per browser (localStorage). lets the user pick the accent + timeline
//scrub colours and set a custom title/logo for the top-left. applied by writing CSS variables that
//the tailwind tokens (see tailwind.config.js) and the scrubber css read.

export interface Theme {
  accent: string;   //hex
  scrub: string;    //hex
  title: string;
  logo: string | null; //data url
}

export const DEFAULT_THEME: Theme = { accent: "#C2620B", scrub: "#C2620B", title: "Context Creator", logo: null };

const KEY = "cc-theme";

export function loadTheme(): Theme {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { ...DEFAULT_THEME }; }
}
export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

type RGB = [number, number, number];
function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const channels = (hex: string) => hexToRgb(hex).join(" ");
function mix([r, g, b]: RGB, [tr, tg, tb]: RGB, amt: number): string {
  const f = (a: number, t: number) => Math.round(a + (t - a) * amt);
  return `#${[f(r, tr), f(g, tg), f(b, tb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
const darken = (hex: string, amt: number) => mix(hexToRgb(hex), [0, 0, 0], amt);
const lighten = (hex: string, amt: number) => mix(hexToRgb(hex), [255, 255, 255], amt);

//derive the small accent palette (hover/soft/ring) from the single chosen accent colour
export function applyTheme(t: Theme) {
  const r = document.documentElement.style;
  r.setProperty("--accent-rgb", channels(t.accent));
  r.setProperty("--accent-hover", darken(t.accent, 0.22));
  r.setProperty("--accent-soft", lighten(t.accent, 0.82));
  r.setProperty("--accent-ring-rgb", channels(lighten(t.accent, 0.15)));
  r.setProperty("--scrub-rgb", channels(t.scrub));
  r.setProperty("--scrub", t.scrub);
}
