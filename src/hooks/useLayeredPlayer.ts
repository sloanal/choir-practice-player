import { useCallback, useEffect, useRef, useState } from "react";
import {
  LayeredPlayer,
  type TrackInput,
  type TrackState,
} from "../audio/engine";

/** How often the position readout refreshes while playing. */
const CLOCK_INTERVAL_MS = 66;

interface LoopState {
  on: boolean;
  start: number;
  end: number;
}

export interface LayeredController {
  status: "loading" | "ready" | "error";
  error?: string;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  loop: LoopState;
  tracks: TrackState[];
  toggle: () => void;
  seek: (pos: number) => void;
  setVolume: (id: string, v: number) => void;
  setMuted: (id: string, m: boolean) => void;
  toggleSolo: (id: string) => void;
  clearSolo: () => void;
  soloOnly: (id: string) => void;
  muteOnly: (id: string) => void;
  playAll: () => void;
  setRate: (r: number) => void;
  setLoopEnabled: (on: boolean) => void;
  setLoopRegion: (start: number, end: number) => void;
  setOnsetDelta: (id: string, delta: number) => void;
}

export function useLayeredPlayer(tracks: TrackInput[]): LayeredController {
  const engineRef = useRef<LayeredPlayer | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const [loop, setLoop] = useState<LoopState>({ on: false, start: 0, end: 0 });
  const [trackStates, setTrackStates] = useState<TrackState[]>([]);

  const key = tracks.map((t) => `${t.id}:${t.url}`).join("|");

  useEffect(() => {
    let disposed = false;
    const engine = new LayeredPlayer();
    engineRef.current = engine;
    setStatus("loading");
    setError(undefined);

    engine.onEnded = () => setPlaying(false);

    engine
      .load(tracks)
      .then(() => {
        if (disposed) return;
        setDuration(engine.duration);
        setTrackStates(engine.getTrackStates());
        setLoop(engine.getLoop());
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });

    return () => {
      disposed = true;
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Position clock
  useEffect(() => {
    let raf = 0;
    let last = -Infinity;
    const tick = (now: number) => {
      const engine = engineRef.current;
      // ~15 fps is smooth for a scrubber and leaves the phone's CPU to audio.
      if (engine && now - last >= CLOCK_INTERVAL_MS) {
        last = now;
        setPosition(engine.getPosition());
        setPlaying(engine.isPlaying);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const refreshTracks = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      setTrackStates(engine.getTrackStates());
      setDuration(engine.duration);
    }
  }, []);

  const toggle = useCallback(() => {
    void engineRef.current?.toggle();
  }, []);
  const seek = useCallback((pos: number) => engineRef.current?.seek(pos), []);
  const setVolume = useCallback(
    (id: string, v: number) => {
      engineRef.current?.setVolume(id, v);
      refreshTracks();
    },
    [refreshTracks],
  );
  const setMuted = useCallback(
    (id: string, m: boolean) => {
      engineRef.current?.setMuted(id, m);
      refreshTracks();
    },
    [refreshTracks],
  );
  const toggleSolo = useCallback(
    (id: string) => {
      engineRef.current?.toggleSolo(id);
      refreshTracks();
    },
    [refreshTracks],
  );
  const clearSolo = useCallback(
    () => {
      engineRef.current?.clearSolo();
      refreshTracks();
    },
    [refreshTracks],
  );
  const soloOnly = useCallback(
    (id: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.clearSolo();
      const already = engine.getTrackStates().find((t) => t.id === id)?.soloed;
      if (!already) engine.toggleSolo(id);
      refreshTracks();
    },
    [refreshTracks],
  );
  const muteOnly = useCallback(
    (id: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.clearSolo();
      for (const t of engine.getTrackStates()) {
        engine.setMuted(t.id, t.id === id);
      }
      refreshTracks();
    },
    [refreshTracks],
  );
  const playAll = useCallback(
    () => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.clearSolo();
      for (const t of engine.getTrackStates()) engine.setMuted(t.id, false);
      refreshTracks();
    },
    [refreshTracks],
  );
  const setRate = useCallback((r: number) => {
    engineRef.current?.setPlaybackRate(r);
    setRateState(r);
  }, []);
  const setLoopEnabled = useCallback((on: boolean) => {
    engineRef.current?.setLoopEnabled(on);
    setLoop((l) => ({ ...l, on }));
  }, []);
  const setLoopRegion = useCallback((start: number, end: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setLoopRegion(start, end);
    setLoop(engine.getLoop());
  }, []);
  const setOnsetDelta = useCallback(
    (id: string, delta: number) => {
      engineRef.current?.setOnsetDelta(id, delta);
      refreshTracks();
    },
    [refreshTracks],
  );

  return {
    status,
    error,
    playing,
    position,
    duration,
    rate,
    loop,
    tracks: trackStates,
    toggle,
    seek,
    setVolume,
    setMuted,
    toggleSolo,
    clearSolo,
    soloOnly,
    muteOnly,
    playAll,
    setRate,
    setLoopEnabled,
    setLoopRegion,
    setOnsetDelta,
  };
}
