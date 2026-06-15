import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { colorFor, contextProgress } from "./model";
import type { Doc, Selected } from "./types";

//per-book graph: contexts are nodes (coloured by type), relationships are edges (directed = arrow).
//all elements are built once + laid out; the scrub just toggles visibility so positions stay put.
export default function Graph({ doc, scrub, selected, onSelect }: {
  doc: Doc; scrub: number; selected: Selected; onSelect: (s: Selected) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  //init the cytoscape instance once
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: [
        { selector: "node", style: {
          "background-color": "data(color)", label: "data(label)",
          "font-size": 11, color: "#222", "text-valign": "bottom", "text-margin-y": 3,
          width: 24, height: 24,
        } },
        { selector: "node.sel", style: { "border-width": 3, "border-color": "#222" } },
        { selector: "edge", style: {
          label: "data(label)", "font-size": 9, color: "#555",
          "curve-style": "bezier", width: 1.5, "line-color": "#bbb",
          "target-arrow-color": "#bbb", "text-rotation": "autorotate",
        } },
        { selector: "edge.directed", style: { "target-arrow-shape": "triangle" } },
        { selector: ".sel", style: { "line-color": "#222", "target-arrow-color": "#222", width: 2.5 } },
      ],
      layout: { name: "cose", animate: false },
      wheelSensitivity: 0.2,
    });
    cy.on("tap", "node", (e) => onSelect({ kind: "context", id: e.target.id() }));
    cy.on("tap", "edge", (e) => onSelect({ kind: "relationship", id: e.target.id() }));
    cy.on("tap", (e) => { if (e.target === cy) onSelect(null); });
    cyRef.current = cy;
    return () => cy.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //rebuild + re-layout when the document structure changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const contexts = doc.contexts || {};
    const els: ElementDefinition[] = [];
    for (const k in contexts) {
      const c = contexts[k];
      els.push({ data: { id: k, label: c.title || k, color: colorFor(c.type) } });
    }
    for (const r of doc.relationships || []) {
      if (contexts[r.from] && contexts[r.to]) {
        els.push({
          data: { id: r.id, source: r.from, target: r.to, label: r.label || "" },
          classes: r.directed === false ? "" : "directed",
        });
      }
    }
    cy.elements().remove();
    cy.add(els);
    cy.layout({ name: "cose", animate: false }).run();
  }, [doc]);

  //apply scrub visibility (a node appears at its progress; an edge once both ends are visible)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const contexts = doc.contexts || {};
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const c = contexts[n.id()];
        const cp = c ? contextProgress(c) : null;
        n.style("display", cp == null || cp <= scrub ? "element" : "none");
      });
      cy.edges().forEach((ed) => {
        const visible = ed.source().style("display") !== "none" && ed.target().style("display") !== "none";
        ed.style("display", visible ? "element" : "none");
      });
    });
  }, [scrub, doc]);

  //highlight the selected element
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("sel");
    if (selected?.id) {
      const el = cy.getElementById(selected.id);
      if (el) el.addClass("sel");
    }
  }, [selected, doc]);

  return <div ref={containerRef} className="w-full h-[540px] border border-gray-200 rounded-lg bg-white" />;
}
