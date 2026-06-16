import { useEffect, useState } from "react";
import { api } from "./api";
import { btn, btnAccent, input } from "./ui";
import { DEFAULT_THEME, type Theme } from "./theme";
import type { User } from "./types";

interface UserRow { id: number; username: string; is_admin: boolean }

//settings modal: appearance (live theming), account (change own credentials), and — for the admin —
//user management. appearance is browser-local; account/users hit the server.
export default function Settings({ me, theme, onThemeChange, onAccountChanged, onClose }: {
  me: User; theme: Theme;
  onThemeChange: (t: Theme) => void; onAccountChanged: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Theme>) => onThemeChange({ ...theme, ...patch });

  function onLogoFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set({ logo: String(reader.result) });
    reader.readAsDataURL(file);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40 animate-fadein" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-auto rounded-2xl border border-line bg-paper-card shadow-pop animate-pop"
           onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center gap-2 px-5 py-3 border-b border-line bg-paper-card/95 backdrop-blur">
          <strong className="text-lg">Settings</strong>
          <span className="flex-1" />
          <button className="text-ink-faint hover:text-ink transition text-2xl leading-none" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="p-5 flex flex-col gap-7">
          <Appearance theme={theme} set={set} onLogoFile={onLogoFile} />
          <Account onChanged={onAccountChanged} />
          {me.is_admin && <Users />}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-sm">{label}</span>
      <div className="flex-1 flex items-center gap-2">{children}</div>
    </div>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
             className="h-8 w-10 rounded-md border border-line bg-paper-card cursor-pointer p-0.5" />
      <input className={`${input} w-28 font-mono`} value={value}
             onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </>
  );
}

function Appearance({ theme, set, onLogoFile }: {
  theme: Theme; set: (p: Partial<Theme>) => void; onLogoFile: (f: File | undefined) => void;
}) {
  return (
    <Section title="Appearance">
      <Row label="Accent colour"><ColorField value={theme.accent} onChange={(v) => set({ accent: v })} /></Row>
      <Row label="Timeline colour"><ColorField value={theme.scrub} onChange={(v) => set({ scrub: v })} /></Row>
      <Row label="Title">
        <input className={`${input} flex-1`} value={theme.title} placeholder="Context Creator"
               onChange={(e) => set({ title: e.target.value })} />
      </Row>
      <Row label="Logo">
        {theme.logo && <img src={theme.logo} alt="" className="h-8 w-8 rounded object-contain border border-line" />}
        <label className={`${btn} cursor-pointer`}>
          {theme.logo ? "Replace" : "Upload"}
          <input type="file" accept="image/*" className="hidden"
                 onChange={(e) => onLogoFile(e.target.files?.[0])} />
        </label>
        {theme.logo && <button className={btn} onClick={() => set({ logo: null })}>Remove</button>}
      </Row>
      <div>
        <button className={btn} onClick={() => set({ ...DEFAULT_THEME })}>Reset appearance to defaults</button>
      </div>
    </Section>
  );
}

function Account({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMsg(null);
    if (!current) { setMsg({ ok: false, text: "enter your current password" }); return; }
    if (password && password !== confirm) { setMsg({ ok: false, text: "new passwords don't match" }); return; }
    if (!username.trim() && !password) { setMsg({ ok: false, text: "nothing to change" }); return; }
    try {
      await api("/api/account", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_username: username.trim() || null, new_password: password || null }),
      });
      setMsg({ ok: true, text: "saved" });
      setCurrent(""); setUsername(""); setPassword(""); setConfirm("");
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Section title="Account">
      <Row label="Current password">
        <input className={`${input} flex-1`} type="password" value={current} autoComplete="current-password"
               onChange={(e) => setCurrent(e.target.value)} />
      </Row>
      <Row label="New username">
        <input className={`${input} flex-1`} value={username} placeholder="leave blank to keep"
               onChange={(e) => setUsername(e.target.value)} />
      </Row>
      <Row label="New password">
        <input className={`${input} flex-1`} type="password" value={password} placeholder="leave blank to keep"
               autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
      </Row>
      {password && (
        <Row label="Confirm password">
          <input className={`${input} flex-1`} type="password" value={confirm}
                 onChange={(e) => setConfirm(e.target.value)} />
        </Row>
      )}
      <div className="flex items-center gap-3">
        <button className={btnAccent} onClick={save}>Save changes</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </Section>
  );
}

function Users() {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api<UserRow[]>("/api/users").then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);

  async function add() {
    setMsg(null);
    if (!username.trim() || !password) { setMsg({ ok: false, text: "username and password required" }); return; }
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ username: username.trim(), password }) });
      setUsername(""); setPassword(""); setMsg({ ok: true, text: "user added" });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Section title="Users">
      <div className="rounded-lg border border-line divide-y divide-line">
        {(rows || []).map((u) => (
          <div key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1 truncate">{u.username}</span>
            {u.is_admin && <span className="text-[11px] uppercase tracking-wide text-accent-hover font-semibold">admin</span>}
          </div>
        ))}
        {rows && rows.length === 0 && <div className="px-3 py-2 text-sm text-ink-faint">no users</div>}
        {!rows && <div className="px-3 py-2 text-sm text-ink-faint">loading…</div>}
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className={`${input} flex-1 min-w-[120px]`} placeholder="new username" value={username}
               onChange={(e) => setUsername(e.target.value)} />
        <input className={`${input} flex-1 min-w-[120px]`} type="password" placeholder="password" value={password}
               onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className={btnAccent} onClick={add}>Add user</button>
      </div>
      {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</span>}
      <p className="text-xs text-ink-faint">New users get their own separate set of books and contexts. They sync from KOReader with their own username and password.</p>
    </Section>
  );
}
