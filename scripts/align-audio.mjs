#!/usr/bin/env node
/** Render reviewed elastic maps; publish the manifest only after all succeed. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateRecipe, recipeFingerprint } from "./lib/alignment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MANIFEST_PATH = path.join(ROOT, "public/manifest.json");
const recipes = JSON.parse(await fs.readFile(path.join(HERE, "audio-alignment.json"), "utf8"));
const ffmpeg = [process.env.FFMPEG_PATH,
  "/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64",
  "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg",
].find(candidate => candidate && existsSync(candidate));
const python = process.env.AUDIO_PYTHON || (existsSync(path.join(ROOT, ".audio-venv/bin/python"))
  ? path.join(ROOT, ".audio-venv/bin/python") : "python3");
if (!ffmpeg) throw new Error("FFmpeg not found. Set FFMPEG_PATH.");
const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
if (/sample data/i.test(manifest.source || "")) throw new Error("Refusing to align sample audio with real-recording maps.");

let aligned = 0, skipped = 0;
for (const song of manifest.songs || []) {
  const recipe = recipes.songs[song.id];
  if (!recipe) {
    console.warn(`No reviewed timing map for ${song.id}; leaving it unprocessed.`);
    continue;
  }
  validateRecipe(recipe);
  if (recipe.title) song.title = recipe.title;
  for (const part of ["high", "mid", "low"]) {
    const file = song.singing?.[part];
    if (!file) throw new Error(`Missing ${song.id}/${part}.`);
    const correction = recipe.parts[part];
    const rawPath = file.rawPath || file.path;
    const input = path.join(ROOT, "public", rawPath);
    const sourceHash = createHash("sha256").update(await fs.readFile(input)).digest("hex");
    if (sourceHash !== correction.sourceSha256) {
      throw new Error(`${song.id}/${part}: source recording changed. Review/rebuild its timing map before rendering.`);
    }
    const fingerprint = recipeFingerprint(recipes.version, recipe, part);
    const alignedPath = `audio/${song.id}/singing-${part}-aligned-v${recipes.version}-${fingerprint.slice(0, 12)}.m4a`;
    const output = path.join(ROOT, "public", alignedPath);
    if (file.alignment?.fingerprint === fingerprint && file.path === alignedPath && existsSync(output)) {
      skipped++;
      continue;
    }
    const temporary = output.replace(/\.m4a$/, ".tmp.m4a");
    process.stdout.write(`  ↔ ${song.id}/${part} … `);
    // Reuse only complete content-addressed files from an interrupted batch.
    if (!existsSync(output)) {
      await run(python, [path.join(HERE, "render-aligned-audio.py"), "--input", input,
        "--output", temporary, "--song", song.id, "--part", part, "--ffmpeg", ffmpeg]);
      await fs.rename(temporary, output);
    }
    file.sourceSize = (await fs.stat(input)).size;
    file.rawPath = rawPath;
    file.path = alignedPath;
    file.size = (await fs.stat(output)).size;
    file.alignment = {
      version: recipes.version, fingerprint, method: recipes.method,
      duration: recipe.duration, referencePart: recipe.referencePart,
      sections: correction.sections.length,
      anchors: correction.sections.reduce((n, s) => n + s.anchors.length, 0),
    };
    aligned++;
    console.log("done");
  }
}
manifest.alignmentVersion = recipes.version;
manifest.alignedAt = new Date().toISOString();
await fs.writeFile(MANIFEST_PATH + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
await fs.rename(MANIFEST_PATH + ".tmp", MANIFEST_PATH);
console.log(`Aligned ${aligned} singing tracks; ${skipped} already current.`);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error.trim() || `Renderer exited ${code}`)));
  });
}
