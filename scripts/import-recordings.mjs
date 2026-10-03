#!/usr/bin/env node
/** Build a raw public manifest from the locally verified Dropbox exports. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EXTRAS_DIR, groupExtras, groupSongs } from "./lib/grouping.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RECORDINGS = path.join(ROOT, "recordings", "Fall’26 Section Parts for LCC");
const AUDIO = path.join(ROOT, "public", "audio");
const MANIFEST = path.join(ROOT, "public", "manifest.json");
const ALIASES = JSON.parse(await fs.readFile(path.join(HERE, "song-aliases.json"), "utf8"));

if (!existsSync(RECORDINGS)) {
  throw new Error(`Recordings folder not found: ${RECORDINGS}`);
}

async function walk(dir, base = dir) {
  const entries = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...(await walk(absolute, base)));
    else if (/\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(item.name)) {
      const stat = await fs.stat(absolute);
      entries.push({
        path: "/" + path.relative(base, absolute).split(path.sep).join("/"),
        name: item.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        contentHash: await sha256(absolute),
        localPath: absolute,
      });
    }
  }
  return entries;
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

const raw = await walk(RECORDINGS);
const { songs, warnings } = groupSongs(raw, ALIASES);
const extras = groupExtras(raw, songs);
const sourceByHash = new Map(raw.map((entry) => [entry.contentHash, entry.localPath]));
for (const warning of [...warnings, ...extras.warnings]) console.warn("  ! " + warning);

if (raw.length !== 90 || songs.length !== 14) {
  throw new Error(`Expected 90 files in 14 songs; found ${raw.length} files in ${songs.length} songs.`);
}

await fs.rm(AUDIO, { recursive: true, force: true });
let copied = 0;
async function copy(file, relative, label) {
  // Shared recordings (Bits & Bobs reused as training) are copied once.
  if (file.path) return;
  const source = sourceByHash.get(file.contentHash);
  if (!source) throw new Error(`Could not resolve source for ${label}.`);
  const destination = path.join(ROOT, "public", relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  file.path = relative;
  copied++;
}

const allExtras = [...extras.general, ...songs.flatMap((song) => song.extras || [])];
for (const extra of allExtras) {
  if (extra.all) await copy(extra.all, `audio/${EXTRAS_DIR}/${extra.id}.m4a`, extra.id);
  for (const [part, file] of Object.entries(extra.parts || {})) {
    await copy(file, `audio/${EXTRAS_DIR}/${extra.id}-${part}.m4a`, `${extra.id}/${part}`);
  }
}
for (const song of songs) {
  for (const kind of ["singing", "training"]) {
    for (const [part, file] of Object.entries(song[kind])) {
      await copy(file, `audio/${song.id}/${kind}-${part}.m4a`, `${song.id}/${kind}/${part}`);
    }
  }
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: "verified local Dropbox playback-stream exports",
  songs,
  extras: extras.general,
};
await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Imported ${copied} tracks across ${songs.length} songs.`);
