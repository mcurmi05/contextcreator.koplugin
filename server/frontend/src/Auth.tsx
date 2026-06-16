import { useEffect, useState } from "react";
import { api } from "./api";
import { btnAccent, input } from "./ui";

//first-run setup if no account exists yet, otherwise login. both hit the session endpoints.
export default function Auth({ onAuthed, title, logo }: { onAuthed: () => void; title: string; logo: string | null }) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ needs_setup: boolean }>("/api/setup")
      .then((s) => setNeedsSetup(s.needs_setup))
      .catch(() => {});
  }, []);

  async function submit() {
    setError("");
    try {
      await api(needsSetup ? "/api/setup" : "/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }),
      });
      onAuthed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="h-full grid place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-5 justify-center">
          {logo
            ? <img src={logo} alt="" className="h-7 w-7 rounded object-contain" />
            : (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="5" cy="6" r="2.4" fill="#4F46E5" /><circle cx="18" cy="9" r="2.4" fill="#0E9F6E" />
                <circle cx="9" cy="18" r="2.4" fill="#C2620B" />
                <path d="M6.8 7.2 16.2 8.6M7 8 8.6 16M16.4 10.6 10.4 16.4" stroke="#A8A29E" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
          <strong className="text-lg tracking-tight">{title || "Context Creator"}</strong>
        </div>
        <div className="rounded-xl border border-line bg-paper-card shadow-card p-5 flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{needsSetup ? "Create your account" : "Welcome back"}</h2>
          <p className="text-sm text-ink-faint -mt-2">
            {needsSetup ? "Set up the first account for this server." : "Log in to browse your synced books."}
          </p>
          <input className={input} placeholder="username" value={username} autoComplete="username"
                 onChange={(e) => setUsername(e.target.value)} />
          <input className={input} type="password" placeholder="password" value={password}
                 autoComplete={needsSetup ? "new-password" : "current-password"}
                 onChange={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className={`${btnAccent} justify-center py-2`} onClick={submit}>
            {needsSetup ? "Create account" : "Log in"}
          </button>
          {error && <p className="text-red-600 text-sm" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}
