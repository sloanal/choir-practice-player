import { useEffect, useState } from "react";
import type { Manifest } from "../types";

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; manifest: Manifest }
  | { status: "error"; message: string };

export function useManifest(): State {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const url = new URL("manifest.json", document.baseURI).href;
    fetch(url, { cache: "no-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Manifest not found (${res.status})`);
        return (await res.json()) as Manifest;
      })
      .then((manifest) => {
        if (cancelled) return;
        if (!manifest.songs || manifest.songs.length === 0) {
          setState({ status: "empty" });
        } else {
          setState({ status: "ready", manifest });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
