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

  if (!books) return <p className="text-gray-500">Loading…</p>;
  if (books.length === 0) {
    return <p className="text-gray-500">No books synced yet. Sync from KOReader and they'll show up here.</p>;
  }
  return (
    <ul className="divide-y divide-gray-100">
      {books.map((b) => (
        <li key={b.book_id} className="py-2">
          <button className="text-blue-700 hover:underline" onClick={() => onOpen(b.book_id)}>
            {b.title || b.book_id}
          </button>
          {b.authors ? <span className="text-gray-500"> — {b.authors}</span> : null}
        </li>
      ))}
    </ul>
  );
}
