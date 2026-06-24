import { useEffect, useLayoutEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import cola from "cytoscape-cola";
import { colorFor, contextProgress, pointText, typeLabel, TYPE_LABELS } from "../lib/model";
import { btnGhost } from "../lib/ui";
import { IconImg, NetworkIcon } from "./icons";
import { NodeCard, RelCard } from "./GraphCard";
import type { GraphPrefs, XY } from "../lib/theme";
import type { Doc, GraphEditOps, PointRef, Selected } from "../lib/types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

//<input type=color> needs #rrggbb. built-ins/overrides are already hex, custom types are hsl() so convert.
function toHex(c: string): string {
  if (c[0] === "#") return c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
  const m = c.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i);
  if (!m) return "#888888";
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

//register the live force-directed layout once.
let registered = false;
function register() { if (!registered) { cytoscape.use(cola); registered = true; } }
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

//node circle grows with how much you've written about it
const nodeSize = (n: number) => 28 + Math.min(n * 4, 24);

//how long the hover-focus dim (and the restore on mouse-out) takes
const FADE_MS = 150;

//per-book graph. contexts are springy nodes (coloured by type, sized by note count), relationships
//are edges. hovering spotlights a neighbourhood, selecting pops a note card anchored to the node
//(rather than just outlining the circle), and the scrub fades in nodes as the story reaches them.
export default function Graph({ doc, scrub, onScrub, selected, onSelect, hiddenTypes, onToggleType, typeColors, onSetTypeColor, onAddPoint, onEditPoint, onMoveNodes, graph, onGraphChange, ops }: {
  doc: Doc; scrub: number; onScrub: (v: number) => void; selected: Selected;
  onSelect: (s: Selected) => void;
  hiddenTypes: Set<string>; onToggleType: (t: string) => void;
  typeColors: Record<string, string>; onSetTypeColor: (t: string, color: string | null) => void;
  onAddPoint: (key: string, text: string) => void;
  onEditPoint: (key: string, ref: PointRef, text: string) => void;
  onMoveNodes: (positions: Record<string, { x: number; y: number }>, record: boolean) => void;
  graph: GraphPrefs; onGraphChange: (g: GraphPrefs) => void;
  ops: GraphEditOps;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutRef = useRef<{ stop: () => void } | null>(null);
  const structRef = useRef<string>("");        //signature of the node/edge set, to know when to relayout
  const rafRef = useRef<number>(0);
  const fadeRafRef = useRef<number>(0);        //drives the manual opacity fade loop

  //live values read inside long-lived cytoscape event handlers
  const scrubRef = useRef(scrub);
  const hiddenRef = useRef(hiddenTypes);
  const focusRef = useRef<Set<string> | null>(null);   //current spotlight (hover or selection)
  const selFocusRef = useRef<Set<string> | null>(null); //spotlight owned by the selection
  const colorsRef = useRef(typeColors);                  //user colour overrides, read inside nodeData
  const onMoveRef = useRef(onMoveNodes);                  //latest position-save callback, for the once-bound drag handler
  const saveTimer = useRef<number>(0);
  const hoverFocusRef = useRef(true);                    //whether hovering a node spotlights its neighbourhood
  const hoverBtnRef = useRef<HTMLButtonElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const clickGuardRef = useRef(false);                   //set right after a drag so the trailing click is ignored
  const graphRef = useRef(graph);                        //latest prefs, read inside the rAF card-placement loop
  useEffect(() => { onMoveRef.current = onMoveNodes; }, [onMoveNodes]);
  useEffect(() => { graphRef.current = graph; }, [graph]);

  const [legendOpen, setLegendOpen] = useState(true);
  const [query, setQuery] = useState("");                //search-box text for finding contexts / dot points
  const [isFs, setIsFs] = useState(false);               //graph filling the whole screen (fullscreen api)
  const [legendBottom, setLegendBottom] = useState<number | null>(null); //px below container top where the legend ends
  //which overlay is being dragged + its live fractional position, so it moves under the cursor before
  //we commit the final spot to the (persisted, exportable) config on drop
  type Which = "hover" | "controls" | "card" | "legend" | "search";
  const [dragging, setDragging] = useState<{ which: Which; p: XY } | null>(null);

  //drag an overlay (hover button / controls / card / legend) to a new spot in the container. distinguishes
  //a real drag from a click via a small movement threshold, commits to the shared config on drop.
  function startDrag(e: React.PointerEvent, el: HTMLElement | null, which: Which) {
    const box = containerRef.current;
    if (!box || !el) return;
    e.preventDefault();
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const grabX = e.clientX - elRect.left, grabY = e.clientY - elRect.top;
    const w = elRect.width, h = elRect.height;
    const boxW = boxRect.width, boxH = boxRect.height;
    const startX = e.clientX, startY = e.clientY;

    //the other draggable overlays this one mustn't be dropped on top of. captured up front (they don't
    //move during the drag), as rects relative to the container. no gap, they can sit flush together.
    const GAP = 0;
    const obstacles = ([hoverBtnRef.current, controlsRef.current, legendRef.current, searchRef.current]
      .filter((o) => o && o !== el) as HTMLElement[])
      .map((o) => { const r = o.getBoundingClientRect(); return { x: r.left - boxRect.left, y: r.top - boxRect.top, w: r.width, h: r.height }; });
    const hits = (l: number, t: number) =>
      obstacles.some((r) => l < r.x + r.w + GAP && l + w > r.x - GAP && t < r.y + r.h + GAP && t + h > r.y - GAP);

    let moved = false;
    let lastPx = { x: elRect.left - boxRect.left, y: elRect.top - boxRect.top };
    let last: XY = { x: lastPx.x / boxW, y: lastPx.y / boxH };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      let nx = clamp(ev.clientX - boxRect.left - grabX, 0, Math.max(0, boxW - w));
      let ny = clamp(ev.clientY - boxRect.top - grabY, 0, Math.max(0, boxH - h));
      //if that spot would overlap another overlay, slide along it (keep one axis at the last good value),
      //and if it's fully boxed in just hold the last good spot
      if (hits(nx, ny)) {
        if (!hits(nx, lastPx.y)) ny = lastPx.y;
        else if (!hits(lastPx.x, ny)) nx = lastPx.x;
        else { nx = lastPx.x; ny = lastPx.y; }
      }
      lastPx = { x: nx, y: ny };
      last = { x: nx / boxW, y: ny / boxH };
      setDragging({ which, p: last });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(null);
      if (!moved) return;
      clickGuardRef.current = true;                       //swallow the click that follows this drag
      setTimeout(() => { clickGuardRef.current = false; }, 0);
      const g = graphRef.current;
      if (which === "hover") onGraphChange({ ...g, hoverBtnPos: last });
      else if (which === "controls") onGraphChange({ ...g, controlsPos: last });
      else if (which === "legend") onGraphChange({ ...g, legendPos: last });
      else if (which === "search") onGraphChange({ ...g, searchPos: last });
      else onGraphChange({ ...g, cardPos: last });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  //resolve the on-screen spot for an overlay: the live drag position if it's the one moving, else the
  //saved position (a fraction), or null to fall back to the default corner css
  const posFor = (which: Which, saved: XY | null): XY | null =>
    dragging?.which === which ? dragging.p : saved;
  const pctStyle = (p: XY | null): React.CSSProperties | undefined =>
    p ? { left: `${p.x * 100}%`, top: `${p.y * 100}%`, right: "auto", bottom: "auto" } : undefined;

  //true fullscreen: blow the graph container up to fill the whole screen via the fullscreen api
  function toggleFullscreen() {
    const box = containerRef.current; if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void box.requestFullscreen?.();
  }
  //track fullscreen state and resize/refit cytoscape when the container's size jumps
  useEffect(() => {
    const onFs = () => {
      setIsFs(!!document.fullscreenElement);
      const cy = cyRef.current; if (!cy) return;
      requestAnimationFrame(() => { cy.resize(); cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 200 }); });
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  //collect every node's position and hand it up to be saved. `record` marks a user move (undoable);
  //the auto-save after an initial arrange passes false so it doesn't create an undo step.
  function savePositions(record: boolean) {
    const cy = cyRef.current; if (!cy) return;
    const positions: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => { const p = n.position(); positions[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) }; });
    onMoveRef.current(positions, record);
  }
  function scheduleSave() {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => savePositions(true), 500);
  }

  //point an element at a target opacity (+ label opacity). we don't set it directly; we record a tween on
  //the element's scratch and let the rAF loop ease it there, starting from wherever it is right now (so a
  //re-hover mid-fade picks up smoothly). already-there elements are left alone.
  function aim(ele: cytoscape.NodeSingular | cytoscape.EdgeSingular, op: number, textOp: number, now: number) {
    const curOp = Number(ele.style("opacity"));
    const curTx = Number(ele.style("text-opacity"));
    if (Math.abs(curOp - op) < 0.004 && Math.abs(curTx - textOp) < 0.004) { ele.removeScratch("_fade"); return; }
    ele.scratch("_fade", { fromOp: curOp, toOp: op, fromTx: curTx, toTx: textOp, start: now, dur: FADE_MS });
  }

  //our own opacity fade loop. cytoscape's stylesheet transitions and its animate() both refused to ease
  //node opacity smoothly here, so we just lerp it ourselves every frame, which is fully under our control.
  function runFadeLoop() {
    if (fadeRafRef.current) return; //already running
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); //easeInOutQuad
    const step = () => {
      const cy = cyRef.current;
      if (!cy) { fadeRafRef.current = 0; return; }
      const now = performance.now();
      let active = 0;
      cy.elements().forEach((ele) => {
        const f = ele.scratch("_fade") as undefined | { fromOp: number; toOp: number; fromTx: number; toTx: number; start: number; dur: number };
        if (!f) return;
        const t = f.dur <= 0 ? 1 : Math.min(1, (now - f.start) / f.dur);
        const k = ease(t);
        ele.style({ opacity: f.fromOp + (f.toOp - f.fromOp) * k, "text-opacity": f.fromTx + (f.toTx - f.fromTx) * k });
        if (t >= 1) ele.removeScratch("_fade"); else active++;
      });
      fadeRafRef.current = active > 0 ? requestAnimationFrame(step) : 0;
    };
    fadeRafRef.current = requestAnimationFrame(step);
  }

  //recompute element visibility from scrub + filter, and aim opacity at the spotlight target, in one place
  function refresh() {
    const cy = cyRef.current; if (!cy) return;
    const sc = scrubRef.current, hidden = hiddenRef.current, focus = focusRef.current;
    const now = performance.now();
    cy.nodes().forEach((n) => {
      const cp = n.data("cp") as number | null;
      //a node the story hasn't reached (only ones with dot points are placed), or a filtered-out type,
      //leaves the graph entirely. a context with no dot points always stays visible.
      const ahead = (n.data("np") as number) > 0 && cp != null && cp > sc;
      if (hidden.has(n.data("type") || "unset") || ahead) { n.style("display", "none"); return; }
      n.style({ display: "element", events: "yes" });
      const focused = !focus || focus.has(n.id());
      aim(n, focused ? 1 : 0.16, focused ? 1 : 0.25, now);
    });
    cy.edges().forEach((e) => {
      const s = e.source(), t = e.target();
      if (s.style("display") === "none" || t.style("display") === "none") { e.style("display", "none"); return; }
      e.style("display", "element");
      const focused = !focus || (focus.has(s.id()) && focus.has(t.id()));
      aim(e, focused ? 0.9 : 0.12, focused ? 1 : 0, now);
    });
    runFadeLoop();
  }

  //build the cytoscape instance once
  useEffect(() => {
    register();
    const cy = cytoscape({
      container: canvasRef.current,
      minZoom: 0.2, maxZoom: 2.5, wheelSensitivity: 0.25,
      boxSelectionEnabled: false, //drag on empty space pans, no selection rectangle
      style: [
        { selector: "node", style: {
          "background-color": "data(color)", label: "data(label)",
          width: "data(size)", height: "data(size)",
          "border-width": 2, "border-color": "#FFFFFF",
          "font-family": "Fira Sans, sans-serif", "font-size": 12, "font-weight": 500,
          color: "#1C1917", "text-valign": "bottom", "text-margin-y": 6, "text-max-width": "120px",
          "text-background-color": "#FAF7F2", "text-background-opacity": 0.82,
          "text-background-padding": "2px", "text-background-shape": "roundrectangle",
          //opacity is faded explicitly via ele.animate (see fade()), the rest can use cheap style transitions
          "transition-property": "width, height, background-color",
          "transition-duration": 240, "transition-timing-function": "ease-in-out",
        } },
        { selector: "node.sel", style: {
          "underlay-color": "data(color)", "underlay-opacity": 0.22, "underlay-padding": 12,
          "border-width": 3, "border-color": "data(color)", "z-index": 20,
        } },
        { selector: "edge", style: {
          width: 2, opacity: 0.9, "line-color": "#CFC7BA", "curve-style": "bezier",
          label: "data(label)", "font-family": "Fira Sans, sans-serif", "font-size": 10,
          color: "#57534E", "text-rotation": "autorotate",
          "text-background-color": "#FAF7F2", "text-background-opacity": 0.82, "text-background-padding": "2px",
          "target-arrow-color": "#CFC7BA",
          "transition-property": "line-color",
          "transition-duration": 240, "transition-timing-function": "ease-in-out",
        } },
        { selector: "edge.directed", style: { "target-arrow-shape": "triangle" } },
        { selector: "edge.sel", style: {
          "line-color": "#C2620B", "target-arrow-color": "#C2620B", width: 3, color: "#9A4D08", "z-index": 20,
        } },
        //no grey ring around a node/edge while it's pressed, active, or being dragged
        { selector: "node, edge", style: { "overlay-opacity": 0 } },
        { selector: "node:active, edge:active, node:grabbed", style: { "overlay-opacity": 0 } },
        //no translucent circle at the cursor when pressing/panning the background
        { selector: "core", style: { "active-bg-opacity": 0, "active-bg-size": 0 } as unknown as cytoscape.Css.Core },
      ],
      layout: { name: "preset" },
    });
    cyRef.current = cy;

    const neighbourhood = (id: string) => {
      const set = new Set<string>([id]);
      cy.getElementById(id).connectedEdges().connectedNodes().forEach((n) => { set.add(n.id()); });
      return set;
    };
    //cursor: grab over the (pannable) background, pointer over clickable nodes/edges, grabbing while dragging
    const setCursor = (c: string) => { if (canvasRef.current) canvasRef.current.style.cursor = c; };
    setCursor("grab");
    cy.on("mouseover", "node", (e) => {
      setCursor("pointer");
      if (!hoverFocusRef.current) return;
      focusRef.current = neighbourhood(e.target.id()); refresh();
    });
    cy.on("mouseout", "node", () => { setCursor("grab"); focusRef.current = selFocusRef.current; refresh(); });
    cy.on("mouseover", "edge", () => setCursor("pointer"));
    cy.on("mouseout", "edge", () => setCursor("grab"));
    //grabbing (closed hand) while dragging a node or panning the background, back to the right idle cursor after
    cy.on("grab", "node", () => setCursor("grabbing"));
    cy.on("free", "node", () => setCursor("pointer"));
    cy.on("tapstart", (e) => { if (e.target === cy) setCursor("grabbing"); });
    cy.on("tapend", (e) => { if (e.target === cy) setCursor("grab"); });
    cy.on("tap", "node", (e) => onSelect({ kind: "context", id: e.target.id() }));
    cy.on("tap", "edge", (e) => onSelect({ kind: "relationship", id: e.target.id() }));
    cy.on("tap", (e) => { if (e.target === cy) onSelect(null); });
    cy.on("dragfree", "node", scheduleSave); //save positions after the user drops a node

    return () => { cancelAnimationFrame(fadeRafRef.current); layoutRef.current?.stop(); cy.destroy(); cyRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //sync refs + repaint when scrub/filter change (no relayout)
  useEffect(() => { scrubRef.current = scrub; refresh(); }, [scrub]);
  useEffect(() => { hiddenRef.current = hiddenTypes; refresh(); }, [hiddenTypes]);
  //hover focus on/off lives in the saved config now, mirror it into the ref the hover handler reads, and
  //when it's switched off drop any live hover spotlight back to the selection's (or none)
  useEffect(() => {
    hoverFocusRef.current = graph.hoverFocusOn;
    if (!graph.hoverFocusOn) { focusRef.current = selFocusRef.current; refresh(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.hoverFocusOn]);

  //recolour nodes in place when the user changes a type's colour (node + halo read data(color))
  useEffect(() => {
    colorsRef.current = typeColors;
    const cy = cyRef.current; if (!cy) return;
    cy.batch(() => cy.nodes().forEach((n) => { n.data("color", colorFor(n.data("type"), typeColors)); }));
  }, [typeColors]);

  //rebuild on structural change, otherwise just update node/edge data in place so positions stay put
  useEffect(() => {
    const cy = cyRef.current; if (!cy) return;
    const contexts = doc.contexts || {};
    const layout = doc.layout || {};
    const rels = (doc.relationships || []).filter((r) => contexts[r.from] && contexts[r.to]);
    const struct = Object.keys(contexts).sort().join("|") + "##" + rels.map((r) => r.id).sort().join("|");

    const nodeData = (k: string) => {
      const c = contexts[k];
      const np = (c.points || []).length;
      //np = how many dot points it has. a context with none isn't placed on the timeline (its bare anchor
      //isn't real content), so it always shows; one with points is faded in by the earliest point's spot.
      return { id: k, label: c.title || k, color: colorFor(c.type, colorsRef.current), type: c.type || "unset",
               size: nodeSize(np), np, cp: contextProgress(c) };
    };

    if (struct !== structRef.current) {
      //the set of nodes/edges changed: rebuild. start nodes at their saved positions when we have them.
      structRef.current = struct;
      layoutRef.current?.stop();
      cy.elements().remove();
      const keys = Object.keys(contexts);
      cy.add([
        ...keys.map((k) => ({ data: nodeData(k), ...(layout[k] ? { position: { ...layout[k] } } : {}) })),
        ...rels.map((r) => ({ data: { id: r.id, source: r.from, target: r.to, label: r.label || "" },
                              classes: r.directed === false ? "" : "directed" })),
      ]);
      //if every node already has a saved position, place them exactly (preset), no physics, so they
      //stay where you left them. otherwise run a springy layout that settles + stops, then save it.
      const allPlaced = keys.length > 0 && keys.every((k) => layout[k]);
      const opts: cytoscape.LayoutOptions = (allPlaced
        ? { name: "preset", fit: false, animate: false }
        : reducedMotion()
          ? { name: "cose", animate: false }
          : { name: "cola", infinite: false, fit: false, animate: true, maxSimulationTime: 2500,
              nodeSpacing: 18, edgeLength: 135, randomize: false, handleDisconnected: true, avoidOverlap: true }) as cytoscape.LayoutOptions;
      const layout2 = cy.layout(opts);
      layoutRef.current = layout2 as unknown as { stop: () => void };
      layout2.one("layoutstop", () => {
        cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 300 });
        if (!allPlaced) savePositions(false); //persist the freshly-arranged layout (not an undoable step)
      });
      layout2.run();
    } else {
      //same shape: refresh labels/sizes/colours, and animate nodes to saved positions when they changed
      //(this is how undo/redo of a move plays back, the live sim then carries on from there)
      cy.batch(() => Object.keys(contexts).forEach((k) => {
        const n = cy.getElementById(k); if (n.empty()) return;
        n.data(nodeData(k));
        const p = layout[k];
        //only react to a real reposition (undo/redo), not tiny live-physics drift since the last save
        if (p && (Math.abs(n.position("x") - p.x) > 6 || Math.abs(n.position("y") - p.y) > 6)) {
          n.animate({ position: { x: p.x, y: p.y } }, { duration: 220 });
        }
      }));
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  //selection: mark sel class, own the spotlight, and anchor the note card to the element
  useEffect(() => {
    const cy = cyRef.current; if (!cy) return;
    cy.elements().removeClass("sel");
    cancelAnimationFrame(rafRef.current);

    if (!selected) { selFocusRef.current = null; focusRef.current = null; refresh(); return; }
    const el = cy.getElementById(selected.id);
    if (el.empty()) { selFocusRef.current = null; focusRef.current = null; refresh(); return; }
    el.addClass("sel");
    const focus = new Set<string>();
    if (selected.kind === "context") {
      focus.add(selected.id);
      el.connectedEdges().connectedNodes().forEach((n) => { focus.add(n.id()); });
    } else {
      focus.add(el.source().id()); focus.add(el.target().id());
    }
    selFocusRef.current = focus; focusRef.current = focus; refresh();

    //place the card each frame. fixed mode pins it to the user's spot (React sets left/top), so we only
    //keep it visible. anchored mode follows the element on the chosen side, riding the live physics/pan.
    const place = () => {
      const card = cardRef.current, box = containerRef.current;
      if (!card || !box) { rafRef.current = requestAnimationFrame(place); return; }
      if (graphRef.current.cardMode === "fixed") {
        card.style.visibility = "visible";
        rafRef.current = requestAnimationFrame(place);
        return;
      }
      const visible = el.nonempty() && el.style("display") !== "none";
      card.style.visibility = visible ? "visible" : "hidden";
      if (visible) {
        let p: cytoscape.Position;
        if (selected.kind === "context") {
          p = el.renderedPosition();
        } else {
          const sp = el.source().renderedPosition(), tp = el.target().renderedPosition();
          p = { x: (sp.x + tp.x) / 2, y: (sp.y + tp.y) / 2 };
        }
        const W = box.clientWidth, H = box.clientHeight;
        const cw = card.offsetWidth, ch = card.offsetHeight;
        const r = selected.kind === "context" ? (el.renderedWidth() / 2) : 8;
        const gap = 16;
        let x: number, y: number;
        switch (graphRef.current.cardSide) {
          case "left":  x = p.x - r - gap - cw; y = p.y - ch / 2; break;
          case "above": x = p.x - cw / 2; y = p.y - r - gap - ch; break;
          case "below": x = p.x - cw / 2; y = p.y + r + gap; break;
          default:      x = p.x + r + gap; y = p.y - ch / 2;       //right
        }
        //flip to the opposite side if the preferred one runs off the edge
        if (x + cw > W - 8) x = p.x - r - gap - cw;
        if (x < 8) x = p.x + r + gap;
        if (y + ch > H - 8) y = p.y - r - gap - ch;
        if (y < 8) y = p.y + r + gap;
        card.style.left = clamp(x, 8, Math.max(8, W - cw - 8)) + "px";
        card.style.top = clamp(y, 8, Math.max(8, H - ch - 8)) + "px";
      }
      rafRef.current = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, doc]);

  //tidy reset: lay the visible nodes out on an even grid and stop the live sim so they stay put
  function resetLayout() {
    const cy = cyRef.current; if (!cy) return;
    layoutRef.current?.stop();
    const visible = cy.nodes().filter((n) => n.style("display") !== "none");
    const eles = visible.length ? visible : cy.nodes();
    const layout = eles.layout({
      name: "grid", animate: true, animationDuration: 400, avoidOverlap: true, fit: false, spacingFactor: 1.3,
    } as cytoscape.LayoutOptions);
    layoutRef.current = layout as unknown as { stop: () => void };
    layout.run();
    setTimeout(() => { cy.animate({ fit: { eles, padding: 60 }, duration: 320 }); savePositions(true); }, 440);
  }

  //relationship-aware layout (different to the grid): run a force-directed sim (cola) over just the
  //visible nodes/edges. force-directed naturally drags the most-connected nodes toward the centre and
  //pushes loosely linked ones outward. edge length scales with the label so the full relationship text
  //has room to sit on the line, and handleDisconnected tucks free nodes neatly off to the side.
  function arrangeByRelationships() {
    const cy = cyRef.current; if (!cy) return;
    layoutRef.current?.stop();
    const visN = cy.nodes().filter((n) => n.style("display") !== "none");
    const nodes = visN.nonempty() ? visN : cy.nodes();
    const edges = cy.edges().filter((e) => e.style("display") !== "none" &&
      e.source().style("display") !== "none" && e.target().style("display") !== "none");
    const eles = nodes.union(edges);
    const layout = eles.layout({
      name: "cola", infinite: false, fit: false, animate: true, maxSimulationTime: 4500,
      randomize: true, avoidOverlap: true, handleDisconnected: true,
      //pad each node by roughly half its own label width, so a long name doesn't sit on top of a neighbour
      nodeSpacing: (node: cytoscape.NodeSingular) => 26 + String(node.data("label") || "").length * 3,
      //longer labels need a longer edge so the text isn't covered by the two nodes it joins
      edgeLength: (edge: cytoscape.EdgeSingular) => 170 + String(edge.data("label") || "").length * 9,
      //give cola plenty of iterations to actually resolve the overlap constraints before it stops
      unconstrIter: 15, userConstIter: 20, allConstIter: 40,
    } as unknown as cytoscape.LayoutOptions);
    layoutRef.current = layout as unknown as { stop: () => void };
    layout.one("layoutstop", () => {
      cy.animate({ fit: { eles, padding: 60 }, duration: 320 });
      savePositions(true);
    });
    layout.run();
  }

  //jump the camera to a context node and select it. if it sits ahead of the timeline scrub, or its type
  //is filtered out, reveal it first so it's actually on screen, then centre on it once that settles.
  function focusNode(key: string) {
    const cy = cyRef.current; if (!cy) return;
    const node = cy.getElementById(key);
    if (node.empty()) return;
    const cp = node.data("cp") as number | null;
    if ((node.data("np") as number) > 0 && cp != null && cp > scrubRef.current) onScrub(cp);
    const type = (node.data("type") as string) || "unset";
    if (hiddenRef.current.has(type)) onToggleType(type);
    onSelect({ kind: "context", id: key });
    //let the reveal/repaint land, then ease over to it (zoom in a touch if we're way out)
    setTimeout(() => { cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1), duration: 350 }); }, 80);
  }

  //legend / filter data: which types are present, counted by what's actually on screen at the current
  //scrub (matching the graph's visibility) — a context placed ahead of the timeline isn't tallied, an
  //unplaced one (no dot points) always is. so the per-type numbers track what you can currently see.
  const contexts = doc.contexts || {};
  const counts: Record<string, number> = {};
  for (const k in contexts) {
    const c = contexts[k];
    const cp = contextProgress(c);
    if ((c.points || []).length > 0 && cp != null && cp > scrub) continue; //ahead of the timeline
    const t = c.type || "unset";
    counts[t] = (counts[t] || 0) + 1;
  }
  const order = ["character", "place", "object", "concept"];
  const present = [
    ...order.filter((t) => counts[t]),
    ...Object.keys(counts).filter((t) => t !== "unset" && !TYPE_LABELS[t]).sort(),
    ...(counts.unset ? ["unset"] : []),
  ];

  //measure where the filter ends so the hover button can default to sitting just beneath it. only when
  //the filter is shown and at its default (un-dragged) top-left spot, otherwise the hover button uses
  //its own corner default. recompute when the filter's size/visibility changes.
  const legendShownDefault = present.length > 0 && graph.showLegend && !graph.legendPos;
  useLayoutEffect(() => {
    const box = containerRef.current, leg = legendRef.current;
    if (!legendShownDefault || !box || !leg) { setLegendBottom(null); return; }
    const b = leg.getBoundingClientRect(), c = box.getBoundingClientRect();
    setLegendBottom(b.bottom - c.top);
  }, [legendShownDefault, legendOpen, present.length, isFs]);

  //resolved placement for the hover-focus button: a dragged/saved spot wins, else just under the filter
  //(top-left) when we have its measured bottom, else the top-left corner
  const hoverSaved = posFor("hover", graph.hoverBtnPos);
  const hoverUnderFilter = !hoverSaved && legendBottom != null;
  const hoverStyle: React.CSSProperties | undefined = hoverSaved
    ? pctStyle(hoverSaved)
    : hoverUnderFilter ? { left: 12, top: legendBottom! + 8, right: "auto", bottom: "auto" } : undefined;
  const hoverCorner = hoverSaved || hoverUnderFilter ? "" : "top-3 left-3";

  const card = renderCard();

  //search hits: contexts whose title matches, then dot points whose text matches (each carries its parent
  //context so picking it jumps to that node). titles first, capped so the dropdown stays manageable.
  const q = query.trim().toLowerCase();
  type Hit = { key: string; title: string; kind: "context" | "point"; snippet?: string };
  const hits: Hit[] = [];
  if (q) {
    for (const k in contexts) {
      const c = contexts[k];
      const title = c.title || k;
      if (title.toLowerCase().includes(q)) { hits.push({ key: k, title, kind: "context" }); continue; }
      //a context also matches via any of its aliases; note which alias matched in the snippet
      const alias = (c.aliases || []).find((a) => a.toLowerCase().includes(q));
      if (alias) hits.push({ key: k, title, kind: "context", snippet: `alias: ${alias}` });
    }
    for (const k in contexts) {
      for (const p of contexts[k].points || []) {
        const text = pointText(p);
        if (text && text.toLowerCase().includes(q)) hits.push({ key: k, title: contexts[k].title || k, kind: "point", snippet: text });
      }
    }
  }
  const shownHits = hits.slice(0, 24);
  const pickHit = (h: Hit) => { focusNode(h.key); setQuery(""); };

  return (
    <div ref={containerRef} className="relative w-full h-full rounded-xl border border-line overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0 graph-canvas" />

      {/* search box: find a context by title or a dot point by its text, click a hit to jump to its node.
          hideable from settings, draggable by its grip (defaults to the top centre). */}
      {graph.showSearch && (
        <div ref={searchRef}
             style={pctStyle(posFor("search", graph.searchPos))}
             className={`absolute z-30 w-[268px] ${posFor("search", graph.searchPos) ? "" : "top-3 left-1/2 -translate-x-1/2"}`}>
          <div className="flex items-center gap-1.5 rounded-xl border border-line bg-paper-card/95 backdrop-blur shadow-card px-2 py-1.5">
            <span onPointerDown={(e) => startDrag(e, searchRef.current, "search")}
                  className="shrink-0 cursor-grab active:cursor-grabbing select-none touch-none" title="Drag to move">
              <IconImg src="/drag.png" className="w-3 h-3 opacity-60" />
            </span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 className="shrink-0 text-ink-faint" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" strokeLinecap="round" />
            </svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && shownHits[0]) pickHit(shownHits[0]); if (e.key === "Escape") setQuery(""); }}
                   placeholder="Search contexts or notes…"
                   className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-ink-faint" />
            {query && (
              <button onClick={() => setQuery("")} title="Clear"
                      className="shrink-0 text-ink-faint hover:text-ink transition text-sm leading-none px-0.5">×</button>
            )}
          </div>
          {q && (
            <div className="mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-paper-card/95 backdrop-blur shadow-card py-1">
              {shownHits.length === 0 ? (
                <div className="px-3 py-2 text-sm text-ink-faint">No matches</div>
              ) : shownHits.map((h, i) => (
                <button key={`${h.kind}-${h.key}-${i}`} onClick={() => pickHit(h)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-paper-sunk transition">
                  <span className="w-2 h-2 rounded-full shrink-0 ring-1 ring-black/10"
                        style={{ background: colorFor(contexts[h.key]?.type, typeColors) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm truncate">{h.title}</span>
                    {h.snippet && <span className="block text-xs text-ink-faint truncate">{h.snippet}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">{h.kind === "point" ? "note" : "context"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* legend doubles as a type filter (click a row) + colour picker (click the swatch). collapsible,
          hideable from settings, and draggable (panel by its header, pill as a whole). */}
      {present.length > 0 && graph.showLegend && (
        legendOpen ? (
          <div ref={legendRef}
               style={pctStyle(posFor("legend", graph.legendPos))}
               className={`absolute z-10 ${posFor("legend", graph.legendPos) ? "" : "top-3 left-3"} rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card p-2 w-[200px]`}>
            <div className="flex items-center gap-1.5 px-1.5 pb-1.5 cursor-grab active:cursor-grabbing select-none touch-none"
                 onPointerDown={(e) => startDrag(e, legendRef.current, "legend")} title="Drag to move">
              <IconImg src="/drag.png" className="w-3 h-3 opacity-60" />
              <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Types · filter</span>
              <button className="text-ink-faint hover:text-ink transition text-sm leading-none px-1" title="Collapse"
                      onPointerDown={(e) => e.stopPropagation()} onClick={() => setLegendOpen(false)}>‹</button>
            </div>
            <div className="flex flex-col gap-0.5">
              {present.map((t) => {
                const off = hiddenTypes.has(t);
                const col = colorFor(t, typeColors);
                const custom = !!typeColors[t];
                return (
                  <div key={t} className={`group flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg transition hover:bg-paper-sunk ${off ? "opacity-40" : ""}`}>
                    {/* swatch = native colour picker; clicking it doesn't toggle the filter */}
                    <label className="relative shrink-0 cursor-pointer" title="Change colour">
                      <span className="block w-3.5 h-3.5 rounded-full ring-1 ring-black/10" style={{ background: col }} />
                      <input type="color" value={toHex(col)} aria-label={`Colour for ${typeLabel(t) || "No type"}`}
                             className="absolute inset-0 opacity-0 cursor-pointer"
                             onChange={(e) => onSetTypeColor(t, e.target.value)} />
                    </label>
                    <button onClick={() => onToggleType(t)}
                            className={`flex-1 flex items-center gap-2 min-w-0 text-left text-sm ${off ? "line-through" : ""}`}>
                      <span className="flex-1 truncate">{typeLabel(t) || "No type"}</span>
                      <span className="text-ink-faint tabular-nums text-xs">{counts[t]}</span>
                    </button>
                    {custom && (
                      <button className="text-ink-faint hover:text-ink transition text-xs leading-none opacity-0 group-hover:opacity-100"
                              title="Reset colour" onClick={() => onSetTypeColor(t, null)}>↺</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <button style={pctStyle(posFor("legend", graph.legendPos))}
                  onPointerDown={(e) => startDrag(e, e.currentTarget, "legend")}
                  className={`absolute z-10 ${posFor("legend", graph.legendPos) ? "" : "top-3 left-3"} rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card px-2.5 py-1.5 text-sm font-medium hover:bg-paper-sunk transition cursor-grab active:cursor-grabbing select-none touch-none`}
                  title="Show filter (drag to move)"
                  onClick={() => { if (clickGuardRef.current) return; setLegendOpen(true); }}>Types ›</button>
        )
      )}

      {/* hover-to-focus toggle: when on, hovering a node dims everything not connected to it. drag to move. */}
      {graph.showHoverFocus && (
        <button
          ref={hoverBtnRef}
          style={hoverStyle}
          onPointerDown={(e) => startDrag(e, hoverBtnRef.current, "hover")}
          className={`absolute z-10 ${hoverCorner} flex items-center gap-1.5 rounded-xl border backdrop-blur shadow-card px-2.5 py-1.5 text-sm font-medium transition cursor-grab active:cursor-grabbing select-none touch-none ${
            graph.hoverFocusOn ? "border-accent bg-accent text-white hover:bg-accent-hover"
                               : "border-line bg-paper-card/90 text-ink-soft hover:bg-paper-sunk"}`}
          aria-pressed={graph.hoverFocusOn}
          title={graph.hoverFocusOn ? "Hover focus on — hovering a node dims unconnected ones. Click to turn off, or drag to move."
                                    : "Hover focus off. Click to dim unconnected nodes on hover, or drag to move."}
          onClick={() => { if (clickGuardRef.current) return; onGraphChange({ ...graph, hoverFocusOn: !graph.hoverFocusOn }); }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="8.5" />
            <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" strokeLinecap="round" />
          </svg>
          Hover focus
        </button>
      )}

      {/* zoom / fit / reset / fullscreen controls, drag the grip to reposition, hideable from settings */}
      {graph.showControls && (
        <div ref={controlsRef}
             style={pctStyle(posFor("controls", graph.controlsPos))}
             className={`absolute z-10 ${posFor("controls", graph.controlsPos) ? "" : "bottom-3 left-3"} flex flex-col rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card overflow-hidden`}>
          <div onPointerDown={(e) => startDrag(e, controlsRef.current, "controls")}
               className="flex items-center justify-center py-1 border-b border-line cursor-grab active:cursor-grabbing select-none touch-none hover:bg-paper-sunk"
               title="Drag to move these controls"><IconImg src="/drag.png" className="w-4 h-3.5" /></div>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom in"
                  onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) * 1.25, duration: 150 })}><IconImg src="/plus.png" /></button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom out"
                  onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) / 1.25, duration: 150 })}><IconImg src="/minus.png" /></button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Fit to view"
                  onClick={() => { const cy = cyRef.current; if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 300 }); }}><IconImg src="/expand.png" /></button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Arrange by relationships (spread out so links read clearly)" onClick={arrangeByRelationships}><NetworkIcon /></button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Reset layout (space nodes evenly)" onClick={resetLayout}><IconImg src="/grid.png" /></button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5`} title={isFs ? "Exit fullscreen" : "Fullscreen graph"}
                  aria-label={isFs ? "Exit fullscreen" : "Fullscreen graph"} onClick={toggleFullscreen}><IconImg src="/fullscreen.png" /></button>
        </div>
      )}

      {/* the note card. anchored mode: positioned every frame by the rAF loop. fixed mode: pinned here. */}
      <div ref={cardRef} className={`absolute z-20 ${selected && card ? "block animate-pop" : "hidden"}`}
           style={graph.cardMode === "fixed" ? pctStyle(posFor("card", graph.cardPos)) : { left: 8, top: 8 }}>
        {card}
      </div>
    </div>
  );

  function renderCard() {
    if (!selected) return null;
    //in fixed mode the card gets a drag grip in its header so it can be repositioned
    const onDrag = graph.cardMode === "fixed" ? (e: React.PointerEvent) => startDrag(e, cardRef.current, "card") : undefined;
    if (selected.kind === "context") {
      const ctx = contexts[selected.id];
      if (!ctx) return null;
      return (
        <NodeCard key={selected.id} ckey={selected.id} ctx={ctx} contexts={contexts}
                  relationships={doc.relationships || []} typeColors={typeColors} scrub={scrub}
                  ops={ops} onAddPoint={onAddPoint} onEditPoint={onEditPoint} onSelect={onSelect} onDrag={onDrag} />
      );
    }
    const rel = (doc.relationships || []).find((r) => r.id === selected.id);
    if (!rel) return null;
    return <RelCard key={rel.id} rel={rel} contexts={contexts} scrub={scrub} ops={ops} onSelect={onSelect} onDrag={onDrag} />;
  }
}
