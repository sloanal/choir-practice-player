import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "bits" }
  | { name: "song"; id: string }
  | { name: "training"; id: string }
  | { name: "singing"; id: string }
  | { name: "extras"; id: string };

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "bits-and-bobs") return { name: "bits" };
  if (parts[0] === "song" && parts[1]) {
    if (parts[2] === "training") return { name: "training", id: parts[1] };
    if (parts[2] === "singing") return { name: "singing", id: parts[1] };
    if (parts[2] === "bits-and-bobs") return { name: "extras", id: parts[1] };
    return { name: "song", id: parts[1] };
  }
  return { name: "home" };
}

function hashFor(route: Route): string {
  let hash = "#/";
  if (route.name === "bits") hash = "#/bits-and-bobs";
  else if (route.name === "song") hash = `#/song/${encodeURIComponent(route.id)}`;
  else if (route.name === "training") hash = `#/song/${encodeURIComponent(route.id)}/training`;
  else if (route.name === "singing") hash = `#/song/${encodeURIComponent(route.id)}/singing`;
  else if (route.name === "extras") hash = `#/song/${encodeURIComponent(route.id)}/bits-and-bobs`;
  return hash;
}

export function navigate(route: Route): void {
  const hash = hashFor(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}

// Each history entry is stamped with how deep into this visit it is and the
// hash it was reached from, so back buttons can return to the page the user
// actually came from instead of a fixed parent.
type Stamp = { depth: number; prev: string | null };

function stamp(): Stamp | null {
  const s = window.history.state as Partial<Stamp> | null;
  return typeof s?.depth === "number" ? (s as Stamp) : null;
}

let current: Stamp & { hash: string } = { depth: 0, prev: null, hash: "" };
let replacing = false;

function track(): void {
  let s = stamp();
  if (replacing) {
    replacing = false;
    s = { depth: current.depth, prev: current.prev };
    window.history.replaceState(s, "");
  } else if (!s) {
    s = current.hash
      ? { depth: current.depth + 1, prev: current.hash }
      : { depth: 0, prev: null };
    window.history.replaceState(s, "");
  }
  current = { ...s, hash: window.location.hash };
}

track();
window.addEventListener("hashchange", track);

/** The route the user arrived from, if they got here by navigating in-app. */
export function previousRoute(): Route | null {
  const s = stamp();
  return s && s.depth > 0 && s.prev !== null ? parse(s.prev) : null;
}

/**
 * Go back to the previous page. If this was the entry page, swap it for
 * `fallback` so a later back doesn't return here.
 */
export function goBack(fallback: Route): void {
  if (previousRoute()) {
    window.history.back();
    return;
  }
  const hash = hashFor(fallback);
  if (window.location.hash === hash) return;
  replacing = true;
  window.location.replace(hash);
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
