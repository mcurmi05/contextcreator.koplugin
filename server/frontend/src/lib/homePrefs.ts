//home page view preferences — sort order, series grouping, manual drag order, and pins. these are
//stored server-side (per account, via /api/prefs) so the shelf layout follows you across browsers and
//devices rather than living in one browser's cache. manual order + pins are kept separately for the
//grouped (series) and flat (books) modes, since the draggable/pinnable unit differs between them.
import { api } from "./api";

export type HomeSort = "author" | "title" | "manual";
export type AuthorSort = "last" | "first"; //sort authors by last name (default) or first name

export interface HomePrefs {
  sort: HomeSort;
  authorSort: AuthorSort;
  group: boolean;
  orderBooks: string[];
  orderSeries: string[];
  pinBooks: string[];
  pinSeries: string[];
}

export const DEFAULT_PREFS: HomePrefs = {
  sort: "author", authorSort: "last", group: true, orderBooks: [], orderSeries: [], pinBooks: [], pinSeries: [],
};

//load the stored prefs, filling any missing fields with defaults (server returns {} until first save).
export async function fetchHomePrefs(): Promise<HomePrefs> {
  try {
    const raw = await api<Partial<HomePrefs>>("/api/prefs");
    return { ...DEFAULT_PREFS, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

//persist the whole prefs object (fire-and-forget; the UI already shows the new state optimistically).
export function saveHomePrefs(prefs: HomePrefs) {
  void api("/api/prefs", { method: "PUT", body: JSON.stringify(prefs) }).catch(() => { /* ignore */ });
}

//the manual order / pins for the current mode (series ids when grouped, book ids when flat)
export const orderFor = (p: HomePrefs, grouped: boolean) => (grouped ? p.orderSeries : p.orderBooks);
export const pinsFor = (p: HomePrefs, grouped: boolean) => (grouped ? p.pinSeries : p.pinBooks);
export const withOrder = (p: HomePrefs, grouped: boolean, order: string[]): HomePrefs =>
  grouped ? { ...p, orderSeries: order } : { ...p, orderBooks: order };
export const withPins = (p: HomePrefs, grouped: boolean, pins: string[]): HomePrefs =>
  grouped ? { ...p, pinSeries: pins } : { ...p, pinBooks: pins };

//order `ids` by a saved manual order: ids present in `order` come first in that order, the rest keep
//their incoming order at the end (so newly-synced items show up without being lost).
export function applyManualOrder(ids: string[], order: string[]): string[] {
  const pos = new Map(order.map((id, i) => [id, i] as const));
  return ids.slice().sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
}
