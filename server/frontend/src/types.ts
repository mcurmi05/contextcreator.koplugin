//the shape of a per-book document, mirroring the device's ContextSchema.

export interface PointObj {
  id?: string;
  text: string;
  pos?: unknown;       //device-only book locator
  progress?: number;   //0..1 narrative position
  chapter?: string;
}
export type Point = string | PointObj; //tolerate legacy bare-string points

export interface Context {
  title: string;
  type?: string;
  points?: Point[];
  updated?: number;
  progress?: number;
  chapter?: string;
  aliases?: string[];   //extra display names that also match this context (set on the device)
}

export interface Relationship {
  id: string;
  from: string;
  to: string;
  label?: string;
  directed?: boolean;  //false = undirected, missing = directed
  points?: Point[];
  updated?: number;
}

export interface TocEntry { title: string; progress: number; }
export interface BookMeta { id?: string; title?: string; authors?: string; toc?: TocEntry[]; }

export interface NodePos { x: number; y: number; }

export interface Doc {
  schema?: number;
  book?: BookMeta;
  source?: string;                     //"device" (syncs to koreader) or "external" (web-only imported doc)
  updated?: number;
  contexts: Record<string, Context>;
  relationships?: Relationship[];
  layout?: Record<string, NodePos>;   //web-set node positions, keyed by context key
  reading_progress?: number | null;   //0..1 fraction the device last read up to
  tombstones?: { contexts: Record<string, number>; relationships: Record<string, number>; points: Record<string, number> };
  profile?: { id: string; name: string };  //which named profile this doc is (server-advertised)
}

//a named context document within a book (alternate note-set)
export interface ProfileSummary { profile_id: string; name: string; updated?: number; }

//where one koreader device has read up to, so "jump to current" can offer each device's spot.
//chapter (+ chapter_frac, fraction through it) lets the web re-anchor a device onto a shared timeline
//that another device built — the raw reading_progress is render-dependent and drifts between devices.
export interface DevicePosition {
  device_id: string; device_name: string; reading_progress: number; updated: number;
  chapter?: string; chapter_frac?: number | null;
}

//locate a dot point for editing/deletion: by stable id when it has one, else by list index
export interface PointRef { id?: string; index: number }

//the full set of graph edits, all routed through BookView (clone doc -> mutate -> PUT, undoable)
export interface GraphEditOps {
  renameContext: (key: string, title: string) => void;
  deleteContext: (key: string) => void;
  setType: (key: string, type: string) => void;
  addAlias: (key: string, text: string) => string | null;  //returns an error message, or null on success
  deleteAlias: (key: string, index: number) => void;
  deletePoint: (key: string, ref: PointRef) => void;
  createLink: (from: string, to: string, label: string, directed: boolean) => void;
  editLinkLabel: (id: string, label: string) => void;
  setLinkDirection: (id: string, from: string, to: string, directed: boolean) => void;
  deleteLink: (id: string) => void;
  addRelPoint: (id: string, text: string) => void;
  editRelPoint: (id: string, ref: PointRef, text: string) => void;
  deleteRelPoint: (id: string, ref: PointRef) => void;
}

export interface BookSummary { book_id: string; title?: string; authors?: string; cover?: string; series?: string; series_index?: number; source?: string; updated?: number; reading_progress?: number | null; profiles?: ProfileSummary[]; }
//a book on the device (from its read history) that has no contexts doc yet
export interface LibraryEntry { book_id: string; title?: string; authors?: string; cover?: string; series?: string; series_index?: number; }
export interface User { id: number; username: string; is_admin?: boolean; }
export type Selected = { kind: "context" | "relationship"; id: string } | null;
