import { useEffect, useState } from "react";
import { api } from "./api";
import Auth from "./Auth";
import BookList from "./BookList";
import BookView from "./BookView";
import { btn } from "./ui";
import type { User } from "./types";

type Phase = "loading" | "auth" | "books" | "book";

//little node-graph glyph for the brand mark
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="6" r="2.4" fill="#4F46E5" />
      <circle cx="18" cy="9" r="2.4" fill="#0E9F6E" />
      <circle cx="9" cy="18" r="2.4" fill="#C2620B" />
      <path d="M6.8 7.2 16.2 8.6M7 8 8.6 16M16.4 10.6 10.4 16.4" stroke="#A8A29E" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<User | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);

  async function checkAuth() {
    try { setMe(await api<User>("/api/me")); setPhase("books"); }
    catch { setMe(null); setPhase("auth"); }
  }
  useEffect(() => { void checkAuth(); }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null); setPhase("auth");
  }

  if (phase === "loading") return <div className="h-full grid place-items-center text-ink-faint">Loading…</div>;
  if (phase === "auth") return <Auth onAuthed={checkAuth} />;

  return (
    <div className="h-full flex flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-2.5 px-5 h-14 border-b border-line bg-paper/85 backdrop-blur">
        <Mark />
        <strong className="tracking-tight">Context Creator</strong>
        <span className="flex-1" />
        {me && <span className="text-ink-soft text-sm hidden sm:inline">{me.username}</span>}
        <button className={btn} onClick={logout}>Log out</button>
      </header>

      <main className="flex-1 min-h-0">
        {phase === "books" && (
          <div className="max-w-3xl mx-auto px-5 py-8">
            <BookList onOpen={(id) => { setBookId(id); setPhase("book"); }} />
          </div>
        )}
        {phase === "book" && bookId && (
          <BookView bookId={bookId} onBack={() => { setBookId(null); setPhase("books"); }} />
        )}
      </main>
    </div>
  );
}
