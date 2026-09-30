import { useCallback, useEffect, useRef, useState } from "react";
import { LayeredPlayer } from "../audio/engine";
import { partsOf, singingInputs } from "../lib/songs";
import type { PartId, Song } from "../types";

export type RepeatMode = "off" | "all" | "one";
export type MixMode = "all" | "mine";

/** Pressing "previous" after this many seconds restarts the current song. */
const RESTART_THRESHOLD = 3;

export interface PlaylistController {
  started: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  playing: boolean;
  position: number;
  duration: number;
  /** Songs in play order (shuffled when shuffle is on). */
  queue: Song[];
  /** Index of the current song within `queue`, or -1 before starting. */
  index: number;
  current: Song | null;
  shuffle: boolean;
  repeat: RepeatMode;
  mix: MixMode;
  volume: number;
  hasNext: boolean;
  start: (opts?: { shuffle?: boolean }) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  jumpTo: (index: number) => void;
  seek: (pos: number) => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
  setMix: (mix: MixMode) => void;
  setVolume: (v: number) => void;
  stop: () => void;
}

export function usePlaylistPlayer(
  songs: Song[],
  myPart: PartId,
): PlaylistController {
  const engineRef = useRef<LayeredPlayer | null>(null);
  const loadTokenRef = useRef(0);
  const cacheRef = useRef(new Map<string, Promise<Blob>>());
  const wantPlayRef = useRef(false);
  const handleEndedRef = useRef<() => void>(() => undefined);

  const [order, setOrder] = useState<number[]>(() =>
    naturalOrder(songs.length)
  );
  const [index, setIndex] = useState(-1);
  const [status, setStatus] = useState<PlaylistController["status"]>("idle");
  const [error, setError] = useState<string>();
  const [enginePlaying, setEnginePlaying] = useState(false);
  const [wantPlay, setWantPlayState] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [mix, setMixState] = useState<MixMode>("all");
  const [volume, setVolumeState] = useState(1);

  // Callbacks fired by the engine or the OS media controls need current values
  // without being re-created on every render.
  const live = useRef({ order, index, shuffle, repeat, mix, myPart, volume });
  live.current = { ...live.current, shuffle, repeat, mix, myPart, volume };

  const setWantPlay = useCallback((on: boolean) => {
    wantPlayRef.current = on;
    setWantPlayState(on);
  }, []);

  const applyMix = useCallback((engine: LayeredPlayer) => {
    const { mix, myPart } = live.current;
    engine.clearSolo();
    if (
      mix === "mine" && engine.getTrackStates().some((t) => t.id === myPart)
    ) {
      engine.toggleSolo(myPart);
    }
  }, []);

  const fetchBytes = useCallback(async (url: string) => {
    const cache = cacheRef.current;
    let pending = cache.get(url);
    if (!pending) {
      pending = fetch(url).then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
        return res.blob();
      });
      pending.catch(() => cache.delete(url));
      cache.set(url, pending);
    }
    // A fresh buffer each time: decodeAudioData detaches the one it is given.
    return (await pending).arrayBuffer();
  }, []);

  const upcoming = useCallback(
    (ord: number[], idx: number): Song | null => {
      const { repeat } = live.current;
      if (repeat === "one") return null;
      if (idx + 1 < ord.length) return songs[ord[idx + 1]];
      if (repeat === "all" && ord.length > 1) return songs[ord[0]];
      return null;
    },
    [songs],
  );

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      const engine = new LayeredPlayer();
      engine.setMasterVolume(live.current.volume);
      engine.onEnded = () => handleEndedRef.current();
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const loadAt = useCallback(
    async (ord: number[], idx: number, fromGesture: boolean) => {
      const engine = getEngine();
      const token = ++loadTokenRef.current;
      // Must start inside the tap on mobile Safari, before any await.
      const unlocking = fromGesture && wantPlayRef.current
        ? engine.unlock()
        : Promise.resolve();
      engine.pause();

      live.current.order = ord;
      live.current.index = idx;
      setOrder(ord);
      setIndex(idx);
      setStatus("loading");
      setError(undefined);
      setPosition(0);
      setDuration(0);

      const song = songs[ord[idx]];
      try {
        await unlocking;
        if (token !== loadTokenRef.current) return;
        const ok = await engine.load(singingInputs(song), fetchBytes);
        if (!ok || token !== loadTokenRef.current) return;
        applyMix(engine);
        setDuration(engine.duration);
        setStatus("ready");

        const nextSong = upcoming(ord, idx);
        const keep = new Set(
          [song, nextSong].flatMap((
            s,
          ) => (s ? singingInputs(s).map((t) => t.url) : [])),
        );
        for (const url of cacheRef.current.keys()) {
          if (!keep.has(url)) cacheRef.current.delete(url);
        }

        if (wantPlayRef.current) await engine.play();
        if (nextSong && token === loadTokenRef.current) {
          for (const input of singingInputs(nextSong)) {
            void fetchBytes(input.url).catch(() => undefined);
          }
        }
      } catch (err) {
        if (token !== loadTokenRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    },
    [songs, getEngine, fetchBytes, applyMix, upcoming],
  );

  handleEndedRef.current = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const { order: ord, index: idx, repeat, shuffle } = live.current;
    if (repeat === "one") {
      void engine.play();
    } else if (idx + 1 < ord.length) {
      void loadAt(ord, idx + 1, false);
    } else if (repeat === "all") {
      const last = ord[idx];
      const nextOrder = shuffle
        ? shuffledOrder(songs.length, undefined, last)
        : ord;
      void loadAt(nextOrder, 0, false);
    } else {
      setWantPlay(false);
      void loadAt(ord, 0, false);
    }
  };

  const start = useCallback(
    (opts?: { shuffle?: boolean }) => {
      if (songs.length === 0) return;
      const on = opts?.shuffle ?? live.current.shuffle;
      live.current.shuffle = on;
      setShuffleState(on);
      setWantPlay(true);
      void loadAt(
        on ? shuffledOrder(songs.length) : naturalOrder(songs.length),
        0,
        true,
      );
    },
    [songs, loadAt, setWantPlay],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      const ord = live.current.order;
      if (idx < 0 || idx >= ord.length) return;
      setWantPlay(true);
      void loadAt(ord, idx, true);
    },
    [loadAt, setWantPlay],
  );

  const toggle = useCallback(() => {
    const engine = engineRef.current;
    const { order: ord, index: idx } = live.current;
    if (!engine || idx < 0) {
      start();
      return;
    }
    if (status === "error") {
      setWantPlay(true);
      void loadAt(ord, idx, true);
    } else if (status === "loading") {
      setWantPlay(!wantPlayRef.current);
      if (wantPlayRef.current) void engine.unlock();
    } else if (engine.isPlaying) {
      engine.pause();
      setWantPlay(false);
    } else {
      setWantPlay(true);
      void engine.play();
    }
  }, [status, start, loadAt, setWantPlay]);

  const next = useCallback(() => {
    const { order: ord, index: idx, repeat } = live.current;
    if (idx < 0) return;
    if (idx + 1 < ord.length) void loadAt(ord, idx + 1, true);
    else if (repeat === "all") void loadAt(ord, 0, true);
  }, [loadAt]);

  const prev = useCallback(() => {
    const engine = engineRef.current;
    const { order: ord, index: idx, repeat } = live.current;
    if (!engine || idx < 0) return;
    const atStart = idx === 0 && repeat !== "all";
    if (engine.getPosition() > RESTART_THRESHOLD || atStart) {
      engine.seek(0);
      setPosition(0);
    } else {
      void loadAt(ord, idx > 0 ? idx - 1 : ord.length - 1, true);
    }
  }, [loadAt]);

  const seek = useCallback((pos: number) => {
    engineRef.current?.seek(pos);
    setPosition(pos);
  }, []);

  const setShuffle = useCallback(
    (on: boolean) => {
      const { order: ord, index: idx } = live.current;
      live.current.shuffle = on;
      setShuffleState(on);
      if (idx < 0) return;
      const current = ord[idx];
      const nextOrder = on
        ? shuffledOrder(songs.length, current)
        : naturalOrder(songs.length);
      const nextIdx = nextOrder.indexOf(current);
      live.current.order = nextOrder;
      live.current.index = nextIdx;
      setOrder(nextOrder);
      setIndex(nextIdx);
    },
    [songs],
  );

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"));
  }, []);

  const setMix = useCallback(
    (m: MixMode) => {
      live.current.mix = m;
      setMixState(m);
      const engine = engineRef.current;
      if (engine) applyMix(engine);
    },
    [applyMix],
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (engine && status === "ready") applyMix(engine);
  }, [myPart, status, applyMix]);

  const setVolume = useCallback((v: number) => {
    live.current.volume = v;
    setVolumeState(v);
    engineRef.current?.setMasterVolume(v);
  }, []);

  const stop = useCallback(() => {
    loadTokenRef.current++;
    engineRef.current?.pause();
    setWantPlay(false);
    live.current.index = -1;
    setIndex(-1);
    setStatus("idle");
    setPosition(0);
    setDuration(0);
  }, [setWantPlay]);

  const started = index >= 0;

  useEffect(() => {
    if (!started) return;
    let raf = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (engine) {
        setPosition(engine.getPosition());
        setEnginePlaying(engine.isPlaying);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [started]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      loadTokenRef.current++;
      engineRef.current?.dispose();
      engineRef.current = null;
      cache.clear();
    };
  }, []);

  const current = started ? songs[order[index]] ?? null : null;
  const playing = status === "loading" ? wantPlay : enginePlaying;

  const actions = useRef({ toggle, next, prev, seek });
  actions.current = { toggle, next, prev, seek };

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || typeof MediaMetadata === "undefined") return;
    if (!current) {
      session.metadata = null;
      return;
    }
    const parts = partsOf(current.singing);
    session.metadata = new MediaMetadata({
      title: current.title,
      artist: mix === "mine" && parts.includes(myPart)
        ? "Just my part"
        : "All parts",
      album: "Choir Practice · Singing playlist",
    });
  }, [current, mix, myPart]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    if (started) session.playbackState = playing ? "playing" : "paused";
    else session.playbackState = "none";
  }, [started, playing]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || !started) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => !wantPlayRef.current && actions.current.toggle()],
      ["pause", () => wantPlayRef.current && actions.current.toggle()],
      ["nexttrack", () => actions.current.next()],
      ["previoustrack", () => actions.current.prev()],
      [
        "seekto",
        (d) => d.seekTime !== undefined && actions.current.seek(d.seekTime),
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* unsupported */
        }
      }
    };
  }, [started]);

  return {
    started,
    status,
    error,
    playing,
    position,
    duration,
    queue: order.map((i) => songs[i]),
    index,
    current,
    shuffle,
    repeat,
    mix,
    volume,
    hasNext: started && (index + 1 < order.length || repeat === "all"),
    start,
    toggle,
    next,
    prev,
    jumpTo,
    seek,
    setShuffle,
    cycleRepeat,
    setMix,
    setVolume,
    stop,
  };
}

function naturalOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Random permutation of 0..n-1. `first` is pinned to the front; `avoidFirst`
 * is kept out of the front so a reshuffle never repeats the song that just
 * ended.
 */
function shuffledOrder(
  n: number,
  first?: number,
  avoidFirst?: number,
): number[] {
  const rest = naturalOrder(n).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (avoidFirst !== undefined && rest.length > 1 && rest[0] === avoidFirst) {
    [rest[0], rest[1]] = [rest[1], rest[0]];
  }
  return first === undefined ? rest : [first, ...rest];
}
