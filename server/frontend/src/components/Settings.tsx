import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { btn, btnAccent, input } from "../lib/ui";
import { DEFAULT_THEME, DEFAULT_GRAPH, normalizeGraph, type Theme, type GraphPrefs, type CardMode, type CardSide } from "../lib/theme";
import { downloadJson, downloadBlob, readJsonFile } from "../lib/files";
import { loadTypeColors, saveTypeColors } from "../lib/typeColors";
import type { User } from "../lib/types";

interface UserRow { id: number; username: string; is_admin: boolean }

//settings modal: appearance (live theming), account (change own credentials), and for the admin,
//user management. appearance is browser-local, account/users hit the server.
export default function Settings({ me, theme, onThemeChange, onAccountChanged, onClose }: {
  me: User; theme: Theme;
  onThemeChange: (t: Theme) => void; onAccountChanged: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"appearance" | "graph" | "data" | "account">("appearance");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Theme>) => onThemeChange({ ...theme, ...patch });

  const tabs = [
    { id: "appearance", label: "Appearance" },
    { id: "graph", label: "Graph" },
    { id: "data", label: "Import / export" },
    { id: "account", label: me.is_admin ? "Account & users" : "Account" },
  ] as const;

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
        <div className="sticky top-0 z-10 px-5 pt-3 border-b border-line bg-paper-card/95 backdrop-blur">
          <div className="flex items-center gap-2">
            <strong className="text-lg">Settings</strong>
            <span className="flex-1" />
            <button className="text-ink-faint hover:text-ink transition text-2xl leading-none" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="flex gap-1 mt-3 -mb-px">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                      className={`px-3 py-1.5 rounded-t-lg text-sm font-medium border-b-2 transition ${
                        tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5 flex flex-col gap-7">
          {tab === "appearance" && <Appearance theme={theme} set={set} onLogoFile={onLogoFile} />}
          {tab === "graph" && <GraphSettings theme={theme} set={set} />}
          {tab === "data" && <DataSection theme={theme} onThemeChange={onThemeChange} />}
          {tab === "account" && <Account onChanged={onAccountChanged} />}
          {tab === "account" && me.is_admin && <Users />}
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

function ColorField({ value, onChange, onReset, isDefault }: {
  value: string; onChange: (v: string) => void; onReset: () => void; isDefault: boolean;
}) {
  return (
    <>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
             className="h-8 w-10 rounded-md border border-line bg-paper-card cursor-pointer p-0.5" />
      <input className={`${input} w-28 font-mono`} value={value}
             onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <button className={`${btn} px-2 py-1 ${isDefault ? "opacity-40 pointer-events-none" : ""}`}
              title="Reset to default" onClick={onReset}>↺</button>
    </>
  );
}

function Appearance({ theme, set, onLogoFile }: {
  theme: Theme; set: (p: Partial<Theme>) => void; onLogoFile: (f: File | undefined) => void;
}) {
  return (
    <Section title="Appearance">
      <Row label="Accent colour">
        <ColorField value={theme.accent} onChange={(v) => set({ accent: v })}
                    onReset={() => set({ accent: DEFAULT_THEME.accent })} isDefault={theme.accent === DEFAULT_THEME.accent} />
      </Row>
      <Row label="Timeline colour">
        <ColorField value={theme.scrub} onChange={(v) => set({ scrub: v })}
                    onReset={() => set({ scrub: DEFAULT_THEME.scrub })} isDefault={theme.scrub === DEFAULT_THEME.scrub} />
      </Row>
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
      <Row label="Home page">
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={theme.showUnstarted} className="h-4 w-4 accent-accent cursor-pointer"
                   onChange={(e) => set({ showUnstarted: e.target.checked })} />
            <span className="text-sm">Show books without contexts yet</span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={theme.showProgress} className="h-4 w-4 accent-accent cursor-pointer"
                   onChange={(e) => set({ showProgress: e.target.checked })} />
            <span className="text-sm">Show reading progress bars</span>
          </label>
        </div>
      </Row>
      <div>
        <button className={btn} onClick={() => set({ ...DEFAULT_THEME })}>Reset appearance to defaults</button>
      </div>
    </Section>
  );
}

//a compact segmented control (one choice highlighted)
function Seg({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  return (
    <div className="flex flex-wrap gap-1 p-0.5 rounded-lg border border-line bg-paper-sunk">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
                className={`px-2.5 py-1 rounded-md text-sm font-medium transition ${
                  value === v ? "bg-paper-card text-ink shadow-card" : "text-ink-soft hover:text-ink"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function GraphSettings({ theme, set }: { theme: Theme; set: (p: Partial<Theme>) => void }) {
  const g = theme.graph;
  const setG = (patch: Partial<GraphPrefs>) => set({ graph: { ...g, ...patch } });
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const sides: CardSide[] = ["left", "right", "above", "below"];

  const Check = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex items-center gap-2.5 cursor-pointer">
      <input type="checkbox" checked={on} className="h-4 w-4 accent-accent cursor-pointer"
             onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">{label}</span>
    </label>
  );

  return (
    <Section title="Graph">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
          <Check on={g.showHoverFocus} onChange={(v) => setG({ showHoverFocus: v })} label="Show the hover focus button" />
          <Check on={g.hoverFocusOn} onChange={(v) => setG({ hoverFocusOn: v })} label="Hover focus on (dim unconnected)" />
        </div>
        <Check on={g.showControls} onChange={(v) => setG({ showControls: v })} label="Show the zoom / fit / grid / fullscreen controls" />
        <Check on={g.showLegend} onChange={(v) => setG({ showLegend: v })} label="Show the type filter / legend" />
        <Check on={g.showSearch} onChange={(v) => setG({ showSearch: v })} label="Show the search box (find contexts / notes)" />
      </div>
      <p className="text-xs text-ink-faint -mt-1.5">
        "Hover focus on" dims everything not connected to the node you hover, toggle it here even if you hide its
        button. Everything you keep visible can be dragged around the graph to sit exactly where you want.
      </p>

      <Row label="Info card">
        <Seg value={g.cardMode} onChange={(v) => setG({ cardMode: v as CardMode })}
             options={[["anchored", "Next to node"], ["fixed", "Fixed spot"]]} />
      </Row>
      {g.cardMode === "anchored" ? (
        <Row label="Card side">
          <Seg value={g.cardSide} onChange={(v) => setG({ cardSide: v as CardSide })}
               options={sides.map((s) => [s, cap(s)] as [string, string])} />
        </Row>
      ) : (
        <p className="text-xs text-ink-faint">On the graph, drag the card by its title bar to pin it where you want.</p>
      )}

      <p className="text-xs text-ink-faint">
        Tip: on the graph, drag the controls cluster by its <span className="font-mono">⠿</span> grip, the filter by its
        header, and the hover button by tapping and dragging. The controls cluster also has a fullscreen button that fills
        the whole screen with the graph. Every graph setting here is saved and travels with your exported appearance config,
        so you can share your exact setup.
      </p>
      <div>
        <button className={btn} onClick={() => set({ graph: { ...DEFAULT_GRAPH } })}>Reset graph layout</button>
      </div>
    </Section>
  );
}

function DataSection({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function exportAppearance() {
    downloadJson("context-creator-appearance.json", { type: "context-creator-appearance", version: 1, theme, typeColors: loadTypeColors() });
  }
  async function importAppearance(file: File) {
    setMsg(null);
    try {
      const data = await readJsonFile<{ theme?: Partial<Theme>; typeColors?: Record<string, string> }>(file);
      if (data.theme) onThemeChange({ ...DEFAULT_THEME, ...data.theme, graph: normalizeGraph(data.theme.graph) });
      if (data.typeColors && typeof data.typeColors === "object") saveTypeColors(data.typeColors);
      setMsg({ ok: true, text: "appearance imported" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  //all contexts download as a zip of one JSON per book, so each book's cover travels with its file
  async function exportContexts() {
    setMsg(null);
    try {
      const res = await fetch("/api/export.zip");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      downloadBlob("context-creator-contexts.zip", await res.blob());
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  //import a whole folder of exported book JSONs at once: read every .json, gather the books, merge in one go
  async function importContexts(files: FileList) {
    setMsg(null);
    try {
      const jsons = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".json"));
      if (!jsons.length) { setMsg({ ok: false, text: "no .json files in that folder" }); return; }
      //read every file defensively so a stray/old/coverless/malformed json doesn't abort the whole import.
      //old exports (no cover, or the single combined bundle) still load — cover is just optional metadata.
      const books: unknown[] = [];
      for (const f of jsons) {
        try {
          const data = await readJsonFile<{ books?: unknown[]; contexts?: unknown; book?: { id?: string } }>(f);
          if (Array.isArray(data?.books)) books.push(...data.books);
          else if (data?.contexts) books.push({ book_id: data.book?.id, doc: data }); //a bare single-book doc
        } catch { /* skip anything that isn't a contexts file */ }
      }
      if (!books.length) { setMsg({ ok: false, text: "no contexts found in those files" }); return; }
      const r = await api<{ imported: number }>("/api/import", {
        method: "POST", body: JSON.stringify({ type: "context-creator-export", version: 2, books }),
      });
      setMsg({ ok: true, text: `imported ${r.imported} book${r.imported === 1 ? "" : "s"} (merged)` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  const pick = (handler: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ""; if (f) handler(f);
  };
  const pickFolder = (handler: (files: FileList) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files; e.target.value = ""; if (fl && fl.length) handler(fl);
  };

  return (
    <Section title="Import / export">
      <Row label="Appearance">
        <button className={btn} onClick={exportAppearance}>Export</button>
        <label className={`${btn} cursor-pointer`}>Import<input type="file" accept=".json,application/json" className="hidden" onChange={pick(importAppearance)} /></label>
      </Row>
      <Row label="All contexts">
        <button className={btn} onClick={exportContexts}>Export (.zip)</button>
        <label className={`${btn} cursor-pointer`}>Import folder
          <input type="file" className="hidden" onChange={pickFolder(importContexts)}
                 {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} /></label>
      </Row>
      {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</span>}
      <p className="text-xs text-ink-faint">Export downloads a zip with one JSON per book (covers included). To import, unzip it and pick the folder, every book's JSON is merged in, nothing is overwritten or lost. You can also export/import a single book from its page.</p>
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
