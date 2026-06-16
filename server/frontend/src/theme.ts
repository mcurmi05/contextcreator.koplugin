//runtime UI theming, persisted per browser (localStorage). lets the user pick the accent + timeline
//scrub colours and set a custom title/logo for the top-left. applied by writing CSS variables that
//the tailwind tokens (see tailwind.config.js) and the scrubber css read.

//where a clicked node's info card appears: anchored to the node (on a chosen side) or pinned to a
//spot the user dragged it to. button positions are fractions (0..1) of the graph container, or null
//to sit in the default corner.
export type CardMode = "anchored" | "fixed";
export type CardSide = "left" | "right" | "above" | "below";
export interface XY { x: number; y: number }

export interface GraphPrefs {
  hoverFocusOn: boolean;       //hovering a node dims everything not connected to it
  showHoverFocus: boolean;     //show the hover-to-focus toggle button on the graph
  showControls: boolean;       //show the zoom/fit/grid/fullscreen controls cluster
  showLegend: boolean;         //show the type filter / legend panel
  cardMode: CardMode;          //node info card: next to the node, or a fixed pinned spot
  cardSide: CardSide;          //which side of the node (anchored mode)
  cardPos: XY;                 //pinned spot as a fraction of the container (fixed mode)
  hoverBtnPos: XY | null;      //custom spot for the hover-focus button (null = top-right corner)
  controlsPos: XY | null;      //custom spot for the zoom/fit/grid controls (null = bottom-right corner)
  legendPos: XY | null;        //custom spot for the type filter / legend (null = top-left corner)
}

export interface Theme {
  accent: string;   //hex
  scrub: string;    //hex
  title: string;
  logo: string | null; //data url
  graph: GraphPrefs;
}

export const DEFAULT_GRAPH: GraphPrefs = {
  hoverFocusOn: true, showHoverFocus: true, showControls: true, showLegend: true, cardMode: "anchored", cardSide: "right",
  cardPos: { x: 0.05, y: 0.08 }, hoverBtnPos: null, controlsPos: null, legendPos: null,
};

export const DEFAULT_THEME: Theme = {
  accent: "#C2620B", scrub: "#C2620B", title: "Context Creator", logo: null, graph: DEFAULT_GRAPH,
};

//fill in any missing graph fields from defaults, so older saved/imported configs still work
export function normalizeGraph(g?: Partial<GraphPrefs> | null): GraphPrefs {
  return { ...DEFAULT_GRAPH, ...(g || {}) };
}

const KEY = "cc-theme";

export function loadTheme(): Theme {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULT_THEME, ...p, graph: normalizeGraph(p.graph) };
  } catch { return { ...DEFAULT_THEME }; }
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
