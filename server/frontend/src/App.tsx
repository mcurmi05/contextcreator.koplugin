import { useEffect, useState } from "react";
import { api } from "./api";
import Auth from "./Auth";
import BookList from "./BookList";
import BookView from "./BookView";
import { btn } from "./ui";
import type { User } from "./types";

type Phase = "loading" | "auth" | "books" | "book";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<User | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);

  async function checkAuth() {
    try {
      setMe(await api<User>("/api/me"));
      setPhase("books");
    } catch {
      setMe(null);
      setPhase("auth");
    }
  }
  useEffect(() => { void checkAuth(); }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
    setPhase("auth");
  }

  if (phase === "loading") return <div className="max-w-5xl mx-auto p-4 text-gray-500">Loading…</div>;
  if (phase === "auth") return <Auth onAuthed={checkAuth} />;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      <div className="max-w-5xl mx-auto p-4">
        <header className="flex items-center gap-3 py-2 border-b border-gray-200 mb-3">
          <strong>Context Creator</strong>
          <span className="flex-1" />
          <span className="text-gray-500 text-sm">{me?.username}</span>
          <button className={btn} onClick={logout}>Log out</button>
        </header>
        {phase === "books" && <BookList onOpen={(id) => { setBookId(id); setPhase("book"); }} />}
        {phase === "book" && bookId && <BookView bookId={bookId} onBack={() => setPhase("books")} />}
      </div>
    </div>
  );
}
