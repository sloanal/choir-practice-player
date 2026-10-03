#!/usr/bin/env node
// Sync a Dropbox shared folder into public/audio + public/manifest.json.
//
// Auth (either):
//   DROPBOX_ACCESS_TOKEN                          (quick, short-lived — good for local runs)
//   DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN   (durable — for CI)
//
// Config:
//   DROPBOX_SHARED_LINK   (defaults to the choir folder link below)

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRAS_DIR, extOf, groupExtras, groupSongs } from "./lib/grouping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const MANIFEST_PATH = path.join(ROOT, "public", "manifest.json");
const ALIASES_PATH = path.join(__dirname, "song-aliases.json");

const DEFAULT_LINK =
  "https://www.dropbox.com/scl/fo/kyd9f5krh3yi9jwmfane0/AAnXhKbsa80rnbMpFnDgx_k?rlkey=nfjhrq1034b00aywltpvy7o4b&dl=0";

const SHARED_LINK = process.env.DROPBOX_SHARED_LINK || DEFAULT_LINK;

// --- Dropbox API helpers ---------------------------------------------------

async function getAccessToken() {
  if (process.env.DROPBOX_ACCESS_TOKEN) return process.env.DROPBOX_ACCESS_TOKEN;
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    throw new Error(
      "Missing Dropbox credentials. Set DROPBOX_ACCESS_TOKEN, or " +
        "DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN."
    );
  }
  const basic = Buffer.from(`${DROPBOX_APP_KEY}:${DROPBOX_APP_SECRET}`).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

// Dropbox requires the Dropbox-API-Arg header to be ASCII; escape non-ASCII.
function apiArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => {
    return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

// Shared links don't support recursive listing, so walk folder-by-folder.
async function listSharedFolder(token) {
  const files = [];
  const queue = [""];

  while (queue.length) {
    const folderPath = queue.shift();
    let json = await listOne(token, { path: folderPath, shared_link: { url: SHARED_LINK } });
    collect(json, files, queue, folderPath);
    while (json.has_more) {
      json = await listContinue(token, json.cursor);
      collect(json, files, queue, folderPath);
    }
  }
  return files;
}

async function listOne(token, body) {
  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, limit: 2000 }),
  });
  if (!res.ok) throw new Error(`list_folder failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listContinue(token, cursor) {
  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cursor }),
  });
  if (!res.ok) throw new Error(`list_folder/continue failed: ${res.status}`);
  return res.json();
}

function collect(json, files, queue, parent) {
  // Shared-link entries often lack path fields, so build paths from names.
  for (const e of json.entries) {
    const path = `${parent}/${e.name}`;
    if (e[".tag"] === "folder") {
      queue.push(path);
    } else if (e[".tag"] === "file") {
      files.push({
        path,
        name: e.name,
        size: e.size,
        contentHash: e.content_hash,
        modified: e.server_modified,
      });
    }
  }
}

async function downloadFile(token, sourcePath, destPath) {
  const res = await fetch("https://content.dropboxapi.com/2/sharing/get_shared_link_file", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": apiArg({ url: SHARED_LINK, path: sourcePath }),
    },
  });
  if (!res.ok) {
    throw new Error(`download failed for ${sourcePath}: ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
}

// --- main ------------------------------------------------------------------

async function loadAliases() {
  if (!existsSync(ALIASES_PATH)) return {};
  try {
    return JSON.parse(await fs.readFile(ALIASES_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function loadPrevManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

function prevHashByPath(prev) {
  const map = new Map();
  if (!prev) return map;
  const remember = (file) => {
    // Prepared tracks keep the original payload beside the rendered
    // output, so the raw cache can be safely reused on the next sync.
    const cachedPath = file.rawPath || file.path;
    if (cachedPath && file.contentHash) map.set(cachedPath, file.contentHash);
  };
  const extras = [...(prev.extras || [])];
  for (const song of prev.songs || []) {
    for (const group of ["singing", "training"]) {
      Object.values(song[group] || {}).forEach(remember);
    }
    extras.push(...(song.extras || []));
  }
  for (const extra of extras) {
    if (extra.all) remember(extra.all);
    Object.values(extra.parts || {}).forEach(remember);
  }
  return map;
}

async function main() {
  console.log(`Syncing from: ${SHARED_LINK}`);
  const token = await getAccessToken();
  const aliases = await loadAliases();

  const rawEntries = await listSharedFolder(token);
  console.log(`Found ${rawEntries.length} files in the shared folder.`);

  const { songs, warnings } = groupSongs(rawEntries, aliases);
  const extras = groupExtras(rawEntries, songs);
  for (const w of [...warnings, ...extras.warnings]) console.warn("  ! " + w);
  console.log(`Grouped into ${songs.length} songs.`);

  const prev = await loadPrevManifest();
  const prevHashes = prevHashByPath(prev);

  let downloaded = 0;
  let skipped = 0;

  async function fetchFile(file, relNoExt) {
    // Shared recordings (Bits & Bobs reused as training) are fetched once.
    if (file.path) return;
    const rel = relNoExt + (extOf(file.name) || ".m4a");
    const dest = path.join(ROOT, "public", rel);
    const unchanged = prevHashes.get(rel) === file.contentHash && existsSync(dest);
    if (unchanged) {
      skipped++;
    } else {
      process.stdout.write(`  ↓ ${rel} … `);
      await downloadFile(token, file.sourcePath, dest);
      downloaded++;
      console.log("done");
    }
    file.path = rel;
    delete file.sourcePath;
  }

  const allExtras = [...extras.general, ...songs.flatMap((song) => song.extras || [])];
  for (const extra of allExtras) {
    if (extra.all) await fetchFile(extra.all, `audio/${EXTRAS_DIR}/${extra.id}`);
    for (const [part, file] of Object.entries(extra.parts || {})) {
      await fetchFile(file, `audio/${EXTRAS_DIR}/${extra.id}-${part}`);
    }
  }
  for (const song of songs) {
    for (const group of ["singing", "training"]) {
      for (const [part, file] of Object.entries(song[group])) {
        await fetchFile(file, `audio/${song.id}/${group}-${part}`);
      }
    }
  }

  // Remove audio dirs for songs no longer present.
  await pruneOrphans(songs);

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: SHARED_LINK,
    songs,
    extras: extras.general,
  };
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(
    `\nDone. ${downloaded} downloaded, ${skipped} unchanged. Manifest: public/manifest.json`
  );
}

async function pruneOrphans(songs) {
  if (!existsSync(AUDIO_DIR)) return;
  const keep = new Set([...songs.map((s) => s.id), EXTRAS_DIR]);
  const dirs = await fs.readdir(AUDIO_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (d.isDirectory() && !keep.has(d.name)) {
      await fs.rm(path.join(AUDIO_DIR, d.name), { recursive: true, force: true });
      console.log(`  ✕ removed stale ${d.name}`);
    }
  }
}

main().catch((err) => {
  console.error("\nSync failed:", err.message);
  process.exit(1);
});
