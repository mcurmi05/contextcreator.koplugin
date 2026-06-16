import { useEffect, useLayoutEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import cola from "cytoscape-cola";
import { colorFor, contextProgress, typeLabel, TYPE_LABELS } from "./model";
import { btnGhost } from "./ui";
import { NodeCard, RelCard } from "./GraphCard";
import type { GraphPrefs, XY } from "./theme";
import type { Doc, GraphEditOps, PointRef, Selected } from "./types";

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

//per-book graph. contexts are springy nodes (coloured by type, sized by note count), relationships
//are edges. hovering spotlights a neighbourhood, selecting pops a note card anchored to the node
//(rather than just outlining the circle), and the scrub fades in nodes as the story reaches them.
export default function Graph({ doc, scrub, selected, onSelect, hiddenTypes, onToggleType, typeColors, onSetTypeColor, onAddPoint, onEditPoint, onMoveNodes, graph, onGraphChange, ops }: {
  doc: Doc; scrub: number; selected: Selected;
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
  const clickGuardRef = useRef(false);                   //set right after a drag so the trailing click is ignored
  const graphRef = useRef(graph);                        //latest prefs, read inside the rAF card-placement loop
  useEffect(() => { onMoveRef.current = onMoveNodes; }, [onMoveNodes]);
  useEffect(() => { graphRef.current = graph; }, [graph]);

  const [legendOpen, setLegendOpen] = useState(true);
  const [isFs, setIsFs] = useState(false);               //graph filling the whole screen (fullscreen api)
  const [legendBottom, setLegendBottom] = useState<number | null>(null); //px below container top where the legend ends
  //which overlay is being dragged + its live fractional position, so it moves under the cursor before
  //we commit the final spot to the (persisted, exportable) config on drop
  type Which = "hover" | "controls" | "card" | "legend";
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
    const startX = e.clientX, startY = e.clientY;
    let moved = false, last: XY = { x: elRect.left - boxRect.left, y: elRect.top - boxRect.top };
    last = { x: last.x / boxRect.width, y: last.y / boxRect.height };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      const left = clamp(ev.clientX - boxRect.left - grabX, 0, Math.max(0, boxRect.width - w));
      const top = clamp(ev.clientY - boxRect.top - grabY, 0, Math.max(0, boxRect.height - h));
      last = { x: left / boxRect.width, y: top / boxRect.height };
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

  //recompute element opacity/visibility from scrub + filter + spotlight, all in one place
  function refresh() {
    const cy = cyRef.current; if (!cy) return;
    const sc = scrubRef.current, hidden = hiddenRef.current, focus = focusRef.current;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const cp = n.data("cp") as number | null;
        //a node the story hasn't reached, or a filtered-out type, leaves the graph entirely
        if (hidden.has(n.data("type") || "unset") || (cp != null && cp > sc)) { n.style("display", "none"); return; }
        n.style("display", "element");
        const focused = !focus || focus.has(n.id());
        n.style({ opacity: focused ? 1 : 0.16, "text-opacity": focused ? 1 : 0.25, events: "yes" });
      });
      cy.edges().forEach((e) => {
        const s = e.source(), t = e.target();
        if (s.style("display") === "none" || t.style("display") === "none") { e.style("display", "none"); return; }
        e.style("display", "element");
        const focused = !focus || (focus.has(s.id()) && focus.has(t.id()));
        e.style({ opacity: focused ? 0.9 : 0.12, "text-opacity": focused ? 1 : 0 });
      });
    });
  }

  //build the cytoscape instance once
  useEffect(() => {
    register();
    const cy = cytoscape({
      container: canvasRef.current,
      minZoom: 0.2, maxZoom: 2.5, wheelSensitivity: 0.25,
      style: [
        { selector: "node", style: {
          "background-color": "data(color)", label: "data(label)",
          width: "data(size)", height: "data(size)",
          "border-width": 2, "border-color": "#FFFFFF",
          "font-family": "Fira Sans, sans-serif", "font-size": 12, "font-weight": 500,
          color: "#1C1917", "text-valign": "bottom", "text-margin-y": 6, "text-max-width": "120px",
          "text-background-color": "#FAF7F2", "text-background-opacity": 0.82,
          "text-background-padding": "2px", "text-background-shape": "roundrectangle",
          "transition-property": "opacity, width, height", "transition-duration": 160,
        } },
        { selector: "node.sel", style: {
          "underlay-color": "data(color)", "underlay-opacity": 0.22, "underlay-padding": 12,
          "border-width": 3, "border-color": "data(color)", "z-index": 20,
        } },
        { selector: "edge", style: {
          width: 2, "line-color": "#CFC7BA", "curve-style": "bezier",
          label: "data(label)", "font-family": "Fira Sans, sans-serif", "font-size": 10,
          color: "#57534E", "text-rotation": "autorotate",
          "text-background-color": "#FAF7F2", "text-background-opacity": 0.82, "text-background-padding": "2px",
          "target-arrow-color": "#CFC7BA",
          "transition-property": "opacity, line-color", "transition-duration": 160,
        } },
        { selector: "edge.directed", style: { "target-arrow-shape": "triangle" } },
        { selector: "edge.sel", style: {
          "line-color": "#C2620B", "target-arrow-color": "#C2620B", width: 3, color: "#9A4D08", "z-index": 20,
        } },
      ],
      layout: { name: "preset" },
    });
    cyRef.current = cy;

    const neighbourhood = (id: string) => {
      const set = new Set<string>([id]);
      cy.getElementById(id).connectedEdges().connectedNodes().forEach((n) => { set.add(n.id()); });
      return set;
    };
    cy.on("mouseover", "node", (e) => { if (!hoverFocusRef.current) return; focusRef.current = neighbourhood(e.target.id()); refresh(); });
    cy.on("mouseout", "node", () => { focusRef.current = selFocusRef.current; refresh(); });
    cy.on("tap", "node", (e) => onSelect({ kind: "context", id: e.target.id() }));
    cy.on("tap", "edge", (e) => onSelect({ kind: "relationship", id: e.target.id() }));
    cy.on("tap", (e) => { if (e.target === cy) onSelect(null); });
    cy.on("dragfree", "node", scheduleSave); //save positions after the user drops a node

    return () => { layoutRef.current?.stop(); cy.destroy(); cyRef.current = null; };
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
      return { id: k, label: c.title || k, color: colorFor(c.type, colorsRef.current), type: c.type || "unset",
               size: nodeSize((c.points || []).length), cp: contextProgress(c) };
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

  //legend / filter data: which types are actually present, with counts
  const contexts = doc.contexts || {};
  const counts: Record<string, number> = {};
  for (const k in contexts) { const t = contexts[k].type || "unset"; counts[t] = (counts[t] || 0) + 1; }
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

  return (
    <div ref={containerRef} className="relative w-full h-full rounded-xl border border-line overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0 graph-canvas" />

      {/* legend doubles as a type filter (click a row) + colour picker (click the swatch). collapsible,
          hideable from settings, and draggable (panel by its header, pill as a whole). */}
      {present.length > 0 && graph.showLegend && (
        legendOpen ? (
          <div ref={legendRef}
               style={pctStyle(posFor("legend", graph.legendPos))}
               className={`absolute z-10 ${posFor("legend", graph.legendPos) ? "" : "top-3 left-3"} rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card p-2 w-[200px]`}>
            <div className="flex items-center gap-1 px-1.5 pb-1.5 cursor-grab active:cursor-grabbing select-none touch-none"
                 onPointerDown={(e) => startDrag(e, legendRef.current, "legend")} title="Drag to move">
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
               className="flex items-center justify-center leading-none py-1 border-b border-line text-ink-faint cursor-grab active:cursor-grabbing select-none touch-none hover:bg-paper-sunk hover:text-ink"
               title="Drag to move these controls">⠿</div>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom in"
                  onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) * 1.25, duration: 150 })}>+</button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom out"
                  onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) / 1.25, duration: 150 })}>−</button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Fit to view"
                  onClick={() => { const cy = cyRef.current; if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 300 }); }}>⤢</button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5 border-b border-line`} title="Reset layout (space nodes evenly)" onClick={resetLayout}>⊞</button>
          <button className={`${btnGhost} justify-center w-full rounded-none px-2.5 py-1.5`} title={isFs ? "Exit fullscreen" : "Fullscreen graph"}
                  aria-label={isFs ? "Exit fullscreen" : "Fullscreen graph"} onClick={toggleFullscreen}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mx-auto">
              {isFs
                ? <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
                : <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />}
            </svg>
          </button>
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
