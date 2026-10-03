/**
 * Offline support.
 *
 * - App shell (index.html, hashed build assets, manifest.json) is cached so the
 *   app opens without a connection.
 * - Audio the user explicitly saved lives in AUDIO_CACHE (written by the page,
 *   see src/offline/offlineStore.ts) and is served from there before the
 *   network. <audio> elements send Range requests, and iOS refuses to play
 *   media that ignores them, so cached audio is sliced into 206 responses.
 */

const SHELL_CACHE = "choir-shell-v1";
const AUDIO_CACHE = "choir-audio-v1";
const KNOWN_CACHES = [SHELL_CACHE, AUDIO_CACHE];

const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL("./", SCOPE).href;
const MANIFEST_URL = new URL("manifest.json", SCOPE).href;
const AUDIO_PREFIX = new URL("audio/", SCOPE).href;
const ASSETS_PREFIX = new URL("assets/", SCOPE).href;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(cacheShell().catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("choir-") && !KNOWN_CACHES.includes(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin) return;
  url.hash = "";
  url.search = "";
  const href = url.href;

  if (href.startsWith(AUDIO_PREFIX)) {
    event.respondWith(serveAudio(req, href));
  } else if (req.mode === "navigate") {
    event.respondWith(serveNavigation(event));
  } else if (href === MANIFEST_URL) {
    event.respondWith(networkFirst(req, href));
  } else if (href.startsWith(ASSETS_PREFIX)) {
    event.respondWith(cacheFirst(req, href));
  }
});

async function serveAudio(req, href) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(href);
  if (!hit) return fetch(req);
  const range = req.headers.get("range");
  return range ? rangeResponse(hit, range) : hit;
}

async function rangeResponse(full, range) {
  const blob = await full.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = size - 1;
  if (m && m[1] === "" && m[2] !== "") {
    start = Math.max(0, size - Number(m[2]));
  } else if (m && m[1] !== "") {
    start = Number(m[1]);
    if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
  }
  if (!m || start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "audio/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function serveNavigation(event) {
  try {
    const res = await fetch(event.request);
    if (
      res.ok && new URL(res.url || event.request.url).href.startsWith(INDEX_URL)
    ) {
      event.waitUntil(cacheShell(res.clone()).catch(() => undefined));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(INDEX_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(req, href) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(href, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(href);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req, href) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(href);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) await cache.put(href, res.clone());
  return res;
}

/**
 * Cache index.html plus every same-origin asset it references, and drop
 * assets from previous deploys. The page loaded those assets before this
 * worker existed, so they would otherwise never pass through `fetch`.
 */
async function cacheShell(indexRes) {
  const res = indexRes ?? (await fetch(INDEX_URL, { cache: "no-cache" }));
  if (!res.ok) return;
  const html = await res.clone().text();
  const assets = new Set();
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const u = new URL(m[1], INDEX_URL);
    u.hash = "";
    u.search = "";
    if (u.origin === SCOPE.origin && u.href.startsWith(ASSETS_PREFIX)) {
      assets.add(u.href);
    }
  }

  const cache = await caches.open(SHELL_CACHE);
  await cache.put(INDEX_URL, res);
  await Promise.all(
    [...assets].map(async (href) => {
      if (await cache.match(href)) return;
      const r = await fetch(href);
      if (r.ok) await cache.put(href, r);
    }),
  );
  if (!(await cache.match(MANIFEST_URL))) {
    const r = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (r.ok) await cache.put(MANIFEST_URL, r);
  }

  const keep = new Set([INDEX_URL, MANIFEST_URL, ...assets]);
  for (const key of await cache.keys()) {
    if (!keep.has(key.url)) await cache.delete(key);
  }
}
