//a tiny History-API router (no dependency). routes:
//  /home                         -> the books home page
//  /<bookId>                     -> a book, at its default/remembered profile
//  /<bookId>/<profileName>       -> a book, at the named context profile
//the server serves index.html for any non-asset path (see main.py) so deep links + refresh work.
import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "book"; bookId: string; profileName?: string };

//parse a pathname into a route. unknown / empty paths are the home page.
export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts.length === 0 || parts[0].toLowerCase() === "home") return { name: "home" };
  return { name: "book", bookId: parts[0], profileName: parts[1] };
}

//the canonical pathname for a route
export function routePath(r: Route): string {
  if (r.name === "home") return "/home";
  const base = "/" + encodeURIComponent(r.bookId);
  return r.profileName ? base + "/" + encodeURIComponent(r.profileName) : base;
}

//current route + a navigate() that pushes (or replaces) history and updates state. listens to the
//browser back/forward buttons via popstate.
export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((r: Route, replace = false) => {
    const path = routePath(r);
    if (path !== window.location.pathname) {
      if (replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
    setRoute(r);
  }, []);
  return [route, navigate];
}
