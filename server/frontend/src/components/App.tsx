import { useEffect, useState } from "react";
import { api } from "../lib/api";
import Auth from "./Auth";
import BookList from "./BookList";
import BookView from "./BookView";
import Settings from "./Settings";
import { btn, btnGhost } from "../lib/ui";
import { applyTheme, loadTheme, saveTheme, type Theme } from "../lib/theme";
import { useRoute } from "../lib/router";
import type { User } from "../lib/types";

//the default brand mark as an svg data url, used for the favicon when no custom logo is set
const DEFAULT_MARK_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'>" +
  "<circle cx='5' cy='6' r='2.4' fill='#4F46E5'/><circle cx='18' cy='9' r='2.4' fill='#0E9F6E'/>" +
  "<circle cx='9' cy='18' r='2.4' fill='#C2620B'/>" +
  "<path d='M6.8 7.2 16.2 8.6M7 8 8.6 16M16.4 10.6 10.4 16.4' stroke='#A8A29E' stroke-width='1.3' stroke-linecap='round'/></svg>";
const DEFAULT_FAVICON = "data:image/svg+xml," + encodeURIComponent(DEFAULT_MARK_SVG);

//point the browser tab's favicon (and title) at the webapp's logo/title
function applyTabBranding(logo: string | null, title: string) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  link.href = logo || DEFAULT_FAVICON;
  document.title = title || "Context Creator";
}

//little node-graph glyph, the default brand mark when no custom logo is set
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

function Gear() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [route, navigate] = useRoute();
  //home-page cover selection mode: when set from Settings, the home page lets you tick books and Confirm
  //to set them all to this device's cover. dataEpoch bumps to force the home list to refresh covers live.
  const [coverSel, setCoverSel] = useState<{ source: string; label: string } | null>(null);
  const [dataEpoch, setDataEpoch] = useState(0);

  //canonicalise the bare root ("/") to "/home" so visiting the server address lands on a real route
  useEffect(() => {
    if (route.name === "home" && window.location.pathname !== "/home") navigate({ name: "home" }, true);
  }, [route, navigate]);

  useEffect(() => { applyTheme(theme); applyTabBranding(theme.logo, theme.title); }, [theme]);
  function setTheme(t: Theme) { setThemeState(t); saveTheme(t); applyTheme(t); }

  async function checkAuth() {
    try { setMe(await api<User>("/api/me")); }
    catch { setMe(null); }
    finally { setAuthChecked(true); }
  }
  useEffect(() => { void checkAuth(); }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
    navigate({ name: "home" });
  }

  if (!authChecked) return <div className="h-full grid place-items-center text-ink-faint">Loading…</div>;
  if (!me) return <Auth onAuthed={checkAuth} title={theme.title} logo={theme.logo} />;

  return (
    <div className="h-full flex flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-2.5 px-5 h-14 border-b border-line bg-paper/85 backdrop-blur">
        <button onClick={() => navigate({ name: "home" })}
                className="flex items-center gap-2.5 min-w-0 -mx-1 px-1 py-1 rounded-lg hover:bg-paper-sunk transition"
                title="Home" aria-label="Home">
          {theme.logo
            ? <img src={theme.logo} alt="" className="h-7 w-7 rounded object-contain" />
            : <Mark />}
          <strong className="tracking-tight truncate">{theme.title || "Context Creator"}</strong>
        </button>
        <span className="text-ink-soft text-xs font-mono">v{__APP_VERSION__}</span>
        <span className="flex-1" />
        {me && <span className="text-ink-soft text-sm hidden sm:inline">{me.username}</span>}
        <button className={btnGhost} onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><Gear /></button>
        <button className={btn} onClick={logout}>Log out</button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        {route.name === "home" ? (
          <div className="max-w-6xl mx-auto px-4 py-8">
            <BookList showUnstarted={theme.showUnstarted} showProgress={theme.showProgress} reloadSignal={dataEpoch}
                      coverSel={coverSel} onCoverSelDone={() => setCoverSel(null)}
                      onOpen={(id, profileName) => navigate({ name: "book", bookId: id, profileName })} />
          </div>
        ) : (
          <BookView key={route.bookId} bookId={route.bookId} profileName={route.profileName}
                    onProfileChange={(profileName) => navigate({ name: "book", bookId: route.bookId, profileName }, true)}
                    onBack={() => navigate({ name: "home" })}
                    graph={theme.graph} onGraphChange={(g) => setTheme({ ...theme, graph: g })} />
        )}
      </main>

      {settingsOpen && me && (
        <Settings me={me} theme={theme} onThemeChange={setTheme}
                  onAccountChanged={checkAuth} onClose={() => setSettingsOpen(false)}
                  onCoversChanged={() => setDataEpoch((e) => e + 1)}
                  onStartCoverSelection={(source, label) => {
                    setSettingsOpen(false); navigate({ name: "home" }); setCoverSel({ source, label });
                  }} />
      )}
    </div>
  );
}
