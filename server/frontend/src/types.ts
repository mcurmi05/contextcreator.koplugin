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
  updated?: number;
  contexts: Record<string, Context>;
  relationships?: Relationship[];
  layout?: Record<string, NodePos>;   //web-set node positions, keyed by context key
  reading_progress?: number | null;   //0..1 fraction the device last read up to
  tombstones?: { contexts: Record<string, number>; relationships: Record<string, number>; points: Record<string, number> };
}

//locate a dot point for editing/deletion: by stable id when it has one, else by list index
export interface PointRef { id?: string; index: number }

//the full set of graph edits, all routed through BookView (clone doc -> mutate -> PUT, undoable)
export interface GraphEditOps {
  renameContext: (key: string, title: string) => void;
  deleteContext: (key: string) => void;
  setType: (key: string, type: string) => void;
  deletePoint: (key: string, ref: PointRef) => void;
  createLink: (from: string, to: string, label: string, directed: boolean) => void;
  editLinkLabel: (id: string, label: string) => void;
  setLinkDirection: (id: string, from: string, to: string, directed: boolean) => void;
  deleteLink: (id: string) => void;
  addRelPoint: (id: string, text: string) => void;
  editRelPoint: (id: string, ref: PointRef, text: string) => void;
  deleteRelPoint: (id: string, ref: PointRef) => void;
}

export interface BookSummary { book_id: string; title?: string; authors?: string; series?: string; series_index?: number; updated?: number; }
export interface User { id: number; username: string; is_admin?: boolean; }
export type Selected = { kind: "context" | "relationship"; id: string } | null;
