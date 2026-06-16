import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import cola from "cytoscape-cola";
import { colorFor, contextProgress, pointText, pointProgress, typeLabel, TYPE_LABELS } from "./model";
import { btnGhost } from "./ui";
import PointItem from "./PointItem";
import type { Doc, Point, Selected } from "./types";

//ref to locate a point for editing: by stable id when it has one, else by list index
const pointRef = (p: Point, i: number) => ({ id: typeof p === "object" ? p.id : undefined, index: i });

//<input type=color> needs #rrggbb. built-ins/overrides are already hex; custom types are hsl() — convert.
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
export default function Graph({ doc, scrub, selected, onSelect, hiddenTypes, onToggleType, typeColors, onSetTypeColor, onAddPoint, onEditPoint, onMoveNodes }: {
  doc: Doc; scrub: number; selected: Selected;
  onSelect: (s: Selected) => void;
  hiddenTypes: Set<string>; onToggleType: (t: string) => void;
  typeColors: Record<string, string>; onSetTypeColor: (t: string, color: string | null) => void;
  onAddPoint: (key: string, text: string) => void;
  onEditPoint: (key: string, ref: { id?: string; index: number }, text: string) => void;
  onMoveNodes: (positions: Record<string, { x: number; y: number }>, record: boolean) => void;
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
  useEffect(() => { onMoveRef.current = onMoveNodes; }, [onMoveNodes]);

  const [noteText, setNoteText] = useState("");
  const [legendOpen, setLegendOpen] = useState(true);

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
    cy.on("mouseover", "node", (e) => { focusRef.current = neighbourhood(e.target.id()); refresh(); });
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
      //if every node already has a saved position, place them EXACTLY (preset) — no physics, so they
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
      //(this is how undo/redo of a move plays back — the live sim then carries on from there)
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

    //follow the element every frame so the card rides the live physics (and panning/zooming)
    const place = () => {
      const card = cardRef.current, box = containerRef.current;
      const visible = el.nonempty() && el.style("display") !== "none";
      if (card) card.style.visibility = visible ? "visible" : "hidden";
      if (card && box && visible) {
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
        let x = p.x + r + 16;
        if (x + cw > W - 8) x = p.x - r - 16 - cw;
        const y = Math.max(8, Math.min(p.y - 24, H - ch - 8));
        card.style.left = Math.max(8, x) + "px";
        card.style.top = y + "px";
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

  const card = renderCard();

  return (
    <div ref={containerRef} className="relative w-full h-full rounded-xl border border-line overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0 graph-canvas" />

      {/* legend doubles as a type filter (click a row) + colour picker (click the swatch). collapsible. */}
      {present.length > 0 && (
        legendOpen ? (
          <div className="absolute top-3 left-3 z-10 rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card p-2 w-[200px]">
            <div className="flex items-center gap-1 px-1.5 pb-1.5">
              <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Types · filter</span>
              <button className="text-ink-faint hover:text-ink transition text-sm leading-none px-1" title="Hide legend"
                      onClick={() => setLegendOpen(false)}>‹</button>
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
          <button className="absolute top-3 left-3 z-10 rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card px-2.5 py-1.5 text-sm font-medium hover:bg-paper-sunk transition"
                  title="Show legend" onClick={() => setLegendOpen(true)}>Types ›</button>
        )
      )}

      {/* zoom / fit / reset controls */}
      <div className="absolute bottom-3 right-3 z-10 flex flex-col rounded-xl border border-line bg-paper-card/90 backdrop-blur shadow-card overflow-hidden">
        <button className={`${btnGhost} rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom in"
                onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) * 1.25, duration: 150 })}>+</button>
        <button className={`${btnGhost} rounded-none px-2.5 py-1.5 border-b border-line`} title="Zoom out"
                onClick={() => cyRef.current?.animate({ zoom: (cyRef.current.zoom() || 1) / 1.25, duration: 150 })}>−</button>
        <button className={`${btnGhost} rounded-none px-2.5 py-1.5 border-b border-line`} title="Fit to view"
                onClick={() => { const cy = cyRef.current; if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 300 }); }}>⤢</button>
        <button className={`${btnGhost} rounded-none px-2.5 py-1.5`} title="Reset layout (space nodes evenly)" onClick={resetLayout}>⊞</button>
      </div>

      {/* the anchored note card (absolute, positioned every frame by the rAF loop above) */}
      <div ref={cardRef} className={`absolute z-20 ${selected && card ? "block animate-pop" : "hidden"}`} style={{ left: 8, top: 8 }}>
        {card}
      </div>
    </div>
  );

  function renderCard() {
    if (!selected) return null;
    if (selected.kind === "context") {
      const ctx = contexts[selected.id];
      if (!ctx) return null;
      const submit = () => { if (noteText.trim()) { onAddPoint(selected.id, noteText.trim()); setNoteText(""); } };
      return (
        <div className="w-72 max-h-[60%] flex flex-col rounded-xl border border-line bg-paper-card shadow-pop overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorFor(ctx.type, typeColors) }} />
            <strong className="truncate">{ctx.title}</strong>
            {typeLabel(ctx.type) && <span className="text-xs text-ink-faint">{typeLabel(ctx.type)}</span>}
            <span className="flex-1" />
            <button className="text-ink-faint hover:text-ink transition leading-none text-lg" onClick={() => onSelect(null)} aria-label="Close">×</button>
          </div>
          <ul className="px-4 py-2 space-y-1.5 text-sm overflow-auto">
            {(ctx.points || []).map((p, i) => (
              <PointItem key={i} text={pointText(p)} dim={(pointProgress(p) ?? -1) > scrub} editable
                         onSave={(t) => onEditPoint(selected.id, pointRef(p, i), t)} />
            ))}
            {(!ctx.points || ctx.points.length === 0) && <li className="text-ink-faint italic">no notes yet</li>}
          </ul>
          <div className="flex gap-1.5 p-2 border-t border-line bg-paper">
            <input className="flex-1 px-2.5 py-1.5 rounded-lg border border-line bg-paper-card text-sm focus:outline-none focus:border-accent-ring focus:ring-2 focus:ring-accent-ring/30"
                   placeholder="add a note…" value={noteText}
                   onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
            <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition" onClick={submit}>Add</button>
          </div>
        </div>
      );
    }
    const rel = (doc.relationships || []).find((r) => r.id === selected.id);
    if (!rel) return null;
    const fromT = contexts[rel.from]?.title || rel.from;
    const toT = contexts[rel.to]?.title || rel.to;
    return (
      <div className="w-72 max-h-[60%] flex flex-col rounded-xl border border-line bg-paper-card shadow-pop overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
          <strong className="truncate text-sm">{fromT} {rel.directed === false ? "↔" : "→"} {toT}</strong>
          <span className="flex-1" />
          <button className="text-ink-faint hover:text-ink transition leading-none text-lg" onClick={() => onSelect(null)} aria-label="Close">×</button>
        </div>
        {rel.label && <div className="px-4 pt-2 text-sm font-medium text-accent-hover">{rel.label}</div>}
        <ul className="px-4 py-2 space-y-1.5 text-sm overflow-auto">
          {(rel.points || []).map((p, i) => <li key={i} className="flex gap-1.5"><span className="text-accent select-none">•</span><span>{pointText(p)}</span></li>)}
          {(!rel.points || rel.points.length === 0) && <li className="text-ink-faint italic">no notes on this link</li>}
        </ul>
      </div>
    );
  }
}
