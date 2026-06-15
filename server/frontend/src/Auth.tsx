import { useEffect, useState } from "react";
import { api } from "./api";
import { btn, card, input } from "./ui";

//first-run setup if no account exists yet, otherwise login. both hit the session endpoints.
export default function Auth({ onAuthed }: { onAuthed: () => void }) {
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
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onAuthed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <div className={`${card} flex flex-col gap-2`}>
        <h2 className="text-lg font-semibold">{needsSetup ? "Create your account" : "Log in"}</h2>
        <input className={input} placeholder="username" value={username} autoComplete="username"
               onChange={(e) => setUsername(e.target.value)} />
        <input className={input} type="password" placeholder="password" value={password}
               autoComplete={needsSetup ? "new-password" : "current-password"}
               onChange={(e) => setPassword(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button className={btn} onClick={submit}>{needsSetup ? "Create account" : "Log in"}</button>
        {error && <p className="text-red-600 text-sm">{error}</p>}
      </div>
    </div>
  );
}
