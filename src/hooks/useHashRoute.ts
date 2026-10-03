import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "bits" }
  | { name: "song"; id: string }
  | { name: "training"; id: string }
  | { name: "singing"; id: string }
  | { name: "extras"; id: string };

function parse(hash: string): Route {
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

export function navigate(route: Route): void {
  let hash = "#/";
  if (route.name === "bits") hash = "#/bits-and-bobs";
  else if (route.name === "song") hash = `#/song/${encodeURIComponent(route.id)}`;
  else if (route.name === "training") hash = `#/song/${encodeURIComponent(route.id)}/training`;
  else if (route.name === "singing") hash = `#/song/${encodeURIComponent(route.id)}/singing`;
  else if (route.name === "extras") hash = `#/song/${encodeURIComponent(route.id)}/bits-and-bobs`;
  if (window.location.hash !== hash) window.location.hash = hash;
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
