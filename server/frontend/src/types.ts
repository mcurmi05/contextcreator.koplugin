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
  directed?: boolean;  //false = undirected; missing = directed
  points?: Point[];
  updated?: number;
}

export interface TocEntry { title: string; progress: number; }
export interface BookMeta { id?: string; title?: string; authors?: string; toc?: TocEntry[]; }

export interface Doc {
  schema?: number;
  book?: BookMeta;
  updated?: number;
  contexts: Record<string, Context>;
  relationships?: Relationship[];
  tombstones?: unknown;
}

export interface BookSummary { book_id: string; title?: string; authors?: string; updated?: number; }
export interface User { id: number; username: string; }
export type Selected = { kind: "context" | "relationship"; id: string } | null;
