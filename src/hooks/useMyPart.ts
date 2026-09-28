import { useCallback, useEffect, useState } from "react";
import type { PartId } from "../types";

const KEY = "choir-player.myPart";

function read(): PartId {
  const v = localStorage.getItem(KEY);
  return v === "high" || v === "mid" || v === "low" ? v : "mid";
}

export function useMyPart(): [PartId, (p: PartId) => void] {
  const [part, setPart] = useState<PartId>(read);

  useEffect(() => {
    const onStorage = () => setPart(read());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((p: PartId) => {
    localStorage.setItem(KEY, p);
    setPart(p);
  }, []);

  return [part, update];
}
