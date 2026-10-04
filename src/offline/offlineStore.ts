import { useSyncExternalStore } from "react";
import { partsOf, resolveUrl } from "../lib/songs";
import type { ExtraTrack, Manifest, Song, TrackFile } from "../types";

/** Must match AUDIO_CACHE in public/sw.js, which serves these entries. */
const AUDIO_CACHE = "choir-audio-v1";
const VERSION_HEADER = "X-Offline-Version";
const CONCURRENCY = 3;

export const offlineSupported = typeof window !== "undefined" &&
  window.isSecureContext && "caches" in window;

interface Entry {
  url: string;
  version: string;
  size: number;
}

export interface OfflineSnapshot {
  ready: boolean;
  /** URLs fully stored in the offline cache. */
  saved: ReadonlySet<string>;
  /** Queued or downloading URLs → bytes received so far. */
  pending: ReadonlyMap<string, number>;
  error: string | null;
}

export type OfflineState = "none" | "partial" | "saving" | "saved";

export interface OfflineSummary {
  state: OfflineState;
  /** Bytes already stored (plus in-flight progress while saving). */
  bytes: number;
  total: number;
}

const saved = new Set<string>();
const pending = new Map<string, number>();
const queue: Entry[] = [];
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let ready = false;
let readyPromise: Promise<void> | null = null;
let error: string | null = null;
let active = 0;
let snapshot = makeSnapshot();
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function makeSnapshot(): OfflineSnapshot {
  return { ready, saved: new Set(saved), pending: new Map(pending), error };
}

function emit(): void {
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  snapshot = makeSnapshot();
  for (const l of listeners) l();
}

/** Coalesces byte-progress updates so downloads don't re-render per chunk. */
function emitSoon(): void {
  emitTimer ??= setTimeout(emit, 200);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOffline(): OfflineSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

function versionOf(file: TrackFile): string {
  return `${file.contentHash ?? ""}:${file.size}`;
}

function extraFiles(extra: ExtraTrack): TrackFile[] {
  const parts = extra.parts ?? {};
  return [
    ...(extra.all ? [extra.all] : []),
    ...partsOf(parts).map((p) => parts[p]!),
  ];
}

/**
 * Every audio file for these songs (singing, training and their Bits & Bobs)
 * plus any standalone Bits & Bobs, once each — songs can share a recording.
 */
function entriesOf(songs: Song[], extras: ExtraTrack[] = []): Entry[] {
  const files = [
    ...songs.flatMap((song) => [
      ...[song.singing, song.training].flatMap((map) =>
        partsOf(map).map((p) => map[p]!)
      ),
      ...(song.extras ?? []).flatMap(extraFiles),
    ]),
    ...extras.flatMap(extraFiles),
  ];
  const byUrl = new Map<string, Entry>();
  for (const f of files) {
    const url = resolveUrl(f.path);
    byUrl.set(url, { url, version: versionOf(f), size: f.size });
  }
  return [...byUrl.values()];
}

export function summarize(
  snap: OfflineSnapshot,
  songs: Song[],
  extras: ExtraTrack[] = [],
): OfflineSummary {
  let bytes = 0;
  let total = 0;
  let savedCount = 0;
  let count = 0;
  let saving = false;
  for (const e of entriesOf(songs, extras)) {
    count++;
    total += e.size;
    if (snap.saved.has(e.url)) {
      savedCount++;
      bytes += e.size;
    } else if (snap.pending.has(e.url)) {
      saving = true;
      bytes += Math.min(e.size, snap.pending.get(e.url)!);
    }
  }
  const state: OfflineState = saving
    ? "saving"
    : count > 0 && savedCount === count
    ? "saved"
    : savedCount > 0
    ? "partial"
    : "none";
  return { state, bytes, total };
}

/** True when every singing part of the song can play without a network. */
export function singingSaved(snap: OfflineSnapshot, song: Song): boolean {
  return partsOf(song.singing).every((p) =>
    snap.saved.has(resolveUrl(song.singing[p]!.path))
  );
}

/**
 * Load what is already stored and drop anything the current manifest no
 * longer references or whose source changed, so stale audio is never served.
 */
export function syncWithManifest(manifest: Manifest): Promise<void> {
  if (!offlineSupported) return Promise.resolve();
  readyPromise ??= (async () => {
    const wanted = new Map<string, string>();
    for (const e of entriesOf(manifest.songs, manifest.extras)) {
      wanted.set(e.url, e.version);
    }
    try {
      const cache = await caches.open(AUDIO_CACHE);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        const version = res?.headers.get(VERSION_HEADER);
        if (version && wanted.get(req.url) === version) {
          saved.add(req.url);
        } else {
          await cache.delete(req);
        }
      }
    } catch {
      // Storage unavailable (e.g. private browsing); leave nothing saved.
    }
    ready = true;
    emit();
  })();
  return readyPromise;
}

export async function saveSongs(
  songs: Song[],
  extras: ExtraTrack[] = [],
): Promise<void> {
  if (!offlineSupported) return;
  await readyPromise;
  void navigator.storage?.persist?.().catch(() => false);
  error = null;
  for (const e of entriesOf(songs, extras)) {
    if (saved.has(e.url) || pending.has(e.url)) continue;
    pending.set(e.url, 0);
    queue.push(e);
  }
  emit();
  pump();
}

export function cancelSongs(songs: Song[], extras: ExtraTrack[] = []): void {
  const urls = new Set(entriesOf(songs, extras).map((e) => e.url));
  for (let i = queue.length - 1; i >= 0; i--) {
    if (urls.has(queue[i].url)) queue.splice(i, 1);
  }
  for (const url of urls) {
    controllers.get(url)?.abort();
    pending.delete(url);
  }
  emit();
}

export async function removeSongs(
  songs: Song[],
  extras: ExtraTrack[] = [],
): Promise<void> {
  cancelSongs(songs, extras);
  const cache = await caches.open(AUDIO_CACHE);
  for (const e of entriesOf(songs, extras)) {
    await cache.delete(e.url);
    saved.delete(e.url);
  }
  error = null;
  emit();
}

function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const entry = queue.shift()!;
    active++;
    void download(entry).finally(() => {
      active--;
      pump();
    });
  }
}

async function download(entry: Entry): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(entry.url, ctrl);
  try {
    const res = await fetch(entry.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await readBody(res, (n) => {
      if (ctrl.signal.aborted) return;
      pending.set(entry.url, n);
      emitSoon();
    });
    if (ctrl.signal.aborted) return;
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(
      entry.url,
      new Response(blob, {
        headers: {
          "Content-Type": res.headers.get("Content-Type") ?? "audio/mp4",
          "Content-Length": String(blob.size),
          [VERSION_HEADER]: entry.version,
        },
      }),
    );
    if (ctrl.signal.aborted) {
      await cache.delete(entry.url);
      return;
    }
    saved.add(entry.url);
  } catch (err) {
    if (ctrl.signal.aborted) return;
    error = describeError(err);
  } finally {
    if (controllers.get(entry.url) === ctrl) {
      controllers.delete(entry.url);
      pending.delete(entry.url);
    }
    emit();
  }
}

async function readBody(
  res: Response,
  onProgress: (bytes: number) => void,
): Promise<Blob> {
  const type = res.headers.get("Content-Type") ?? "audio/mp4";
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    received += value.byteLength;
    onProgress(received);
  }
  return new Blob(chunks, { type });
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === "QuotaExceededError") {
    return "Not enough storage space on this device.";
  }
  if (err instanceof TypeError) {
    return "Couldn’t reach the server. Check your connection and try again.";
  }
  return err instanceof Error ? err.message : String(err);
}
