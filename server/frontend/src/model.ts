//shared read helpers mirroring the device's data model (ContextSchema/ContextText).
import type { Context, Point, Relationship } from "./types";

export const TYPE_LABELS: Record<string, string> = {
  character: "Character", place: "Location", object: "Object", concept: "Concept",
};
const BUILTIN_COLORS: Record<string, string> = {
  character: "#4F46E5", place: "#0E9F6E", object: "#E11D48", concept: "#7C3AED", unset: "#A8A29E",
};

export function typeLabel(t?: string): string {
  if (!t || t === "unset") return "";
  return TYPE_LABELS[t] || t;
}

export function isCustomType(t?: string): boolean {
  return !!t && t !== "unset" && !TYPE_LABELS[t];
}

//colour for a type. a user override (set via the legend) wins, then fixed built-ins, then a stable
//hue for custom types, then grey for unset.
export function colorFor(t?: string, overrides?: Record<string, string>): string {
  if (t && overrides && overrides[t]) return overrides[t];
  if (t && BUILTIN_COLORS[t]) return BUILTIN_COLORS[t];
  if (!t || t === "unset") return BUILTIN_COLORS.unset;
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

//the built-in/computed default for a type, ignoring overrides (so "reset" can restore it)
export function defaultColorFor(t?: string): string {
  return colorFor(t);
}

export function pointText(p: Point): string {
  return typeof p === "string" ? p : p.text || "";
}

export function pointProgress(p: Point): number | null {
  return typeof p === "object" && typeof p.progress === "number" ? p.progress : null;
}

export function relArrow(rel: Relationship): string {
  return rel.directed === false ? "↔" : "→";
}

//when a context "appears" on the timeline: earliest located point, else its own progress, else null
export function contextProgress(ctx: Context): number | null {
  let min: number | null = null;
  for (const p of ctx.points || []) {
    const pr = pointProgress(p);
    if (pr != null && (min == null || pr < min)) min = pr;
  }
  if (min != null) return min;
  return typeof ctx.progress === "number" ? ctx.progress : null;
}
