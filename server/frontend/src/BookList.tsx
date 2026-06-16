import { useEffect, useState } from "react";
import { api } from "./api";
import type { BookSummary } from "./types";

export default function BookList({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<BookSummary[]>("/api/books").then((b) => alive && setBooks(b)).catch(() => alive && setBooks([]));
    void load();
    const t = setInterval(load, 5000); //pick up newly-synced books
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!books) return <p className="text-ink-faint">Loading…</p>;
  if (books.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-paper-card p-8 text-center">
        <p className="font-medium">No books synced yet</p>
        <p className="text-sm text-ink-faint mt-1">Sync from KOReader and your books will show up here.</p>
      </div>
    );
  }
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint mb-3">Your books</h2>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {books.map((b) => (
          <button key={b.book_id} onClick={() => onOpen(b.book_id)}
                  className="group text-left rounded-xl border border-line bg-paper-card p-4 shadow-card transition hover:shadow-pop hover:-translate-y-0.5 hover:border-accent-ring">
            <strong className="block truncate group-hover:text-accent-hover transition">{b.title || b.book_id}</strong>
            {b.authors && <span className="block text-sm text-ink-faint truncate mt-0.5">{b.authors}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
