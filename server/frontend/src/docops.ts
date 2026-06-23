//client-side document edits for the graph editor. these mirror the device's ContextSchema operations
//(ContextSchema.lua) exactly, same tombstone discipline, so edits made on the web survive the additive
//sync merge and reconcile cleanly with KOReader. every op mutates a doc in place, BookView clones the doc,
//applies one of these, then PUTs the whole thing (web-authoritative replace) so undo/redo works too.
import type { Doc, Point, PointObj, PointRef, Relationship } from "./types";

export function now(): number {
  return Math.floor(Date.now() / 1000); //epoch seconds, matching the device's os.time()
}

export function genId(): string {
  //web-origin id, only needs to be unique (merge unions by id). the "w-" marks where it came from
  return "w-" + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

//mirror of docops.normalize_word (server) / ContextText.normalizeWord (device) so the same title maps to
//the same context key on every side. the char classes below are exactly python's string.punctuation.
export function normalizeWord(word: string): string {
  if (!word) return "";
  let w = word.replace(/\s+/g, " ").trim().toLowerCase();
  w = w.replace(/’/g, "'");                  //curly apostrophe -> straight
  w = w.replace(/^[!-\/:-@[-`{-~]+/, "");          //trim leading punctuation
  w = w.replace(/[!-\/:-@[-`{-~]+$/, "");          //trim trailing punctuation
  w = w.replace(/'s$/, "");                        //possessive 's
  if (w.length > 3) w = w.replace(/s$/, "");        //plural/trailing s on longer words
  return w;
}

type Tombs = { contexts: Record<string, number>; relationships: Record<string, number>; points: Record<string, number> };

//make sure the collections + tombstone tables exist, then hand back the tombstones typed
function tombs(doc: Doc): Tombs {
  doc.contexts ||= {};
  doc.relationships ||= [];
  const t = (doc.tombstones ||= { contexts: {}, relationships: {}, points: {} }) as Tombs;
  t.contexts ||= {}; t.relationships ||= {}; t.points ||= {};
  return t;
}

function pointId(p: Point): string | undefined {
  return typeof p === "object" && p ? p.id : undefined;
}

//record a point's deletion so the additive merge won't resurrect it from the device
function tombstonePoint(doc: Doc, p: Point) {
  const id = pointId(p);
  if (id) tombs(doc).points[id] = now();
}

//locate a point in a list: by stable id when we have one, else by index
function pointIndex(points: Point[], ref: PointRef): number {
  if (ref.id != null) {
    const i = points.findIndex((p) => typeof p === "object" && p && p.id === ref.id);
    if (i >= 0) return i;
  }
  if (ref.index != null && ref.index >= 0 && ref.index < points.length) return ref.index;
  return -1;
}

function findRel(doc: Doc, id: string): Relationship | undefined {
  return (doc.relationships || []).find((r) => r.id === id);
}

//move every relationship endpoint from oldKey to newKey (used when a rename changes the node key).
//a link that collapses onto itself (from == to) is dropped + tombstoned.
function repointRelationships(doc: Doc, oldKey: string, newKey: string) {
  const t = tombs(doc);
  const rels = doc.relationships || [];
  for (let i = rels.length - 1; i >= 0; i--) {
    const rel = rels[i];
    let changed = false;
    if (rel.from === oldKey) { rel.from = newKey; changed = true; }
    if (rel.to === oldKey) { rel.to = newKey; changed = true; }
    if (rel.from === rel.to) { t.relationships[rel.id] = now(); rels.splice(i, 1); }
    else if (changed) { rel.updated = now(); }
  }
}

//rename a context. same key just tweaks the title, a new key moves the node (merging into
//an existing node of that name if one exists), relationships repoint, the old key is tombstoned. returns
//the resulting key so the caller can keep it selected.
export function renameContext(doc: Doc, key: string, newTitle: string): string {
  const t = tombs(doc);
  const node = doc.contexts[key];
  if (!node) return key;
  newTitle = newTitle.trim();
  if (!newTitle || newTitle === node.title) return key;
  const newKey = normalizeWord(newTitle);
  if (!newKey) return key;

  if (newKey === key) {
    node.title = newTitle;
    node.updated = now();
  } else {
    //the node moves to a new key. give its points fresh ids and tombstone the old ones, so the additive
    //merge genuinely drops the old key on the next device sync (a moved point keeping its id would stay
    //"live" under the old key and resurrect it). the point text/anchors are preserved.
    const moved: PointObj[] = (node.points || []).map((p) => {
      tombstonePoint(doc, p);
      return typeof p === "object" && p ? { ...p, id: genId() } : { id: genId(), text: String(p) };
    });
    const target = doc.contexts[newKey];
    if (target) {
      target.points = [...(target.points || []), ...moved]; //merge points into the node that owns this name
      target.updated = now();
    } else {
      node.points = moved;
      node.title = newTitle;
      node.updated = now();
      doc.contexts[newKey] = node;
    }
    repointRelationships(doc, key, newKey);
    delete doc.contexts[key];
    t.contexts[key] = now();
    delete t.contexts[newKey];
    if (doc.layout && doc.layout[key]) { doc.layout[newKey] = doc.layout[key]; delete doc.layout[key]; }
  }
  doc.updated = now();
  return newKey;
}

//remove a context and every relationship that touches it, tombstoning the key, the points, and the
//relationships + their points so the deletion survives a sync (mirrors ContextSchema.deleteNode)
export function deleteContext(doc: Doc, key: string) {
  const t = tombs(doc);
  const node = doc.contexts[key];
  if (node) {
    for (const p of node.points || []) tombstonePoint(doc, p);
    delete doc.contexts[key];
    t.contexts[key] = now();
  }
  const rels = doc.relationships || [];
  for (let i = rels.length - 1; i >= 0; i--) {
    const rel = rels[i];
    if (rel.from === key || rel.to === key) {
      for (const p of rel.points || []) tombstonePoint(doc, p);
      t.relationships[rel.id] = now();
      rels.splice(i, 1);
    }
  }
  if (doc.layout) delete doc.layout[key];
  doc.updated = now();
}

//empty a whole profile: tombstone every context, relationship and point so the cleared state survives
//the additive sync (the device's copy is dropped on its next sync rather than resurrecting everything),
//then drop the live collections + layout. mirrors how deleteContext/deleteLink tombstone, just for all.
export function clearAll(doc: Doc) {
  const t = tombs(doc);
  const ts = now();
  for (const key in doc.contexts) {
    for (const p of doc.contexts[key].points || []) tombstonePoint(doc, p);
    t.contexts[key] = ts;
  }
  for (const rel of doc.relationships || []) {
    for (const p of rel.points || []) tombstonePoint(doc, p);
    t.relationships[rel.id] = ts;
  }
  doc.contexts = {};
  doc.relationships = [];
  doc.layout = {};
  doc.updated = ts;
}

export function setType(doc: Doc, key: string, type: string) {
  const ctx = doc.contexts[key];
  if (!ctx) return;
  ctx.type = type || "unset";
  ctx.updated = now();
  doc.updated = now();
}

//resolve a word to a context key by an exact (normalized) match on a title or alias, mirroring the
//device's ContextView:resolveContextKey. used to keep aliases unambiguous.
export function resolveContextKey(doc: Doc, word: string): string | undefined {
  const norm = normalizeWord(word);
  if (!norm) return undefined;
  if (doc.contexts[norm]) return norm;
  for (const key in doc.contexts) {
    for (const a of doc.contexts[key].aliases || []) {
      if (normalizeWord(a) === norm) return key;
    }
  }
  return undefined;
}

//add an alias (another matching name) to a context. returns an error string if the name already
//resolves to a context (kept unambiguous), or null on success.
export function addAlias(doc: Doc, key: string, text: string): string | null {
  const ctx = doc.contexts[key];
  if (!ctx) return "Context no longer exists.";
  text = text.trim();
  if (!normalizeWord(text)) return "Enter a name.";
  const owner = resolveContextKey(doc, text);
  if (owner === key) return "That name already matches this context.";
  if (owner) return `“${text}” already matches “${doc.contexts[owner].title || owner}”.`;
  ctx.aliases = [...(ctx.aliases || []), text];
  ctx.updated = now();
  doc.updated = now();
  return null;
}

export function deleteAlias(doc: Doc, key: string, index: number) {
  const ctx = doc.contexts[key];
  if (!ctx || !ctx.aliases || index < 0 || index >= ctx.aliases.length) return;
  ctx.aliases = ctx.aliases.filter((_, i) => i !== index);
  ctx.updated = now();
  doc.updated = now();
}

//make an alias the context's main name: swap it with the current title (the old title becomes an alias so
//it still matches), then rename the context to the alias. returns the new context key.
export function promoteAlias(doc: Doc, key: string, index: number): string {
  const ctx = doc.contexts[key];
  if (!ctx || !ctx.aliases || index < 0 || index >= ctx.aliases.length) return key;
  const newTitle = ctx.aliases[index];
  const oldTitle = ctx.title;
  //drop the promoted alias; keep the old title as an alias so the previous name keeps resolving here
  const rest = ctx.aliases.filter((_, i) => i !== index);
  ctx.aliases = oldTitle && normalizeWord(oldTitle) !== normalizeWord(newTitle) ? [...rest, oldTitle] : rest;
  return renameContext(doc, key, newTitle);
}

export function deletePoint(doc: Doc, key: string, ref: PointRef) {
  const ctx = doc.contexts[key];
  if (!ctx) return;
  const pts = ctx.points || [];
  const i = pointIndex(pts, ref);
  if (i < 0) return;
  tombstonePoint(doc, pts[i]);
  pts.splice(i, 1);
  ctx.updated = now();
  doc.updated = now();
}

export function createLink(doc: Doc, from: string, to: string, label: string, directed: boolean) {
  tombs(doc);
  (doc.relationships ||= []).push({
    id: genId(), from, to, label: (label || "").trim(), directed, points: [], updated: now(),
  });
  doc.updated = now();
}

export function editLinkLabel(doc: Doc, id: string, label: string) {
  const r = findRel(doc, id);
  if (!r) return;
  r.label = (label || "").trim();
  r.updated = now();
  doc.updated = now();
}

export function setLinkDirection(doc: Doc, id: string, from: string, to: string, directed: boolean) {
  const r = findRel(doc, id);
  if (!r) return;
  r.from = from; r.to = to; r.directed = directed;
  r.updated = now();
  doc.updated = now();
}

export function deleteLink(doc: Doc, id: string) {
  const t = tombs(doc);
  const rels = doc.relationships || [];
  const i = rels.findIndex((r) => r.id === id);
  if (i < 0) return;
  for (const p of rels[i].points || []) tombstonePoint(doc, p);
  t.relationships[id] = now();
  rels.splice(i, 1);
  doc.updated = now();
}

export function addRelPoint(doc: Doc, id: string, text: string) {
  const r = findRel(doc, id);
  if (!r || !text.trim()) return;
  (r.points ||= []).push({ id: genId(), text: text.trim() });
  r.updated = now();
  doc.updated = now();
}

export function editRelPoint(doc: Doc, id: string, ref: PointRef, text: string) {
  const r = findRel(doc, id);
  if (!r || !text.trim()) return;
  const pts = r.points || [];
  const i = pointIndex(pts, ref);
  if (i < 0) return;
  const p = pts[i];
  if (typeof p !== "object" || !p) pts[i] = { id: genId(), text: text.trim() } as PointObj;
  else { p.text = text.trim(); if (!p.id) p.id = genId(); }
  r.updated = now();
  doc.updated = now();
}

export function deleteRelPoint(doc: Doc, id: string, ref: PointRef) {
  const r = findRel(doc, id);
  if (!r) return;
  const pts = r.points || [];
  const i = pointIndex(pts, ref);
  if (i < 0) return;
  tombstonePoint(doc, pts[i]);
  pts.splice(i, 1);
  r.updated = now();
  doc.updated = now();
}
