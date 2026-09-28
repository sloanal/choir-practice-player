#!/usr/bin/env node
/** Verify manifest completeness, decodability, and exact trio durations. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRecipe, recipeFingerprint } from "./lib/alignment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "public", "manifest.json"), "utf8"));
const recipes = JSON.parse(await fs.readFile(path.join(HERE, "audio-alignment.json"), "utf8"));
const ffmpeg = [
  process.env.FFMPEG_PATH,
  "/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64",
  "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg",
].find((candidate) => candidate && existsSync(candidate));
if (!ffmpeg) throw new Error("FFmpeg not found. Set FFMPEG_PATH.");

const failures = [];
let checked = 0;
if (manifest.songs?.length !== Object.keys(recipes.songs).length) {
  failures.push(`Manifest has ${manifest.songs?.length || 0} songs; expected ${Object.keys(recipes.songs).length}.`);
}

for (const song of manifest.songs || []) {
  const recipe = recipes.songs[song.id];
  if (recipe) validateRecipe(recipe);
  const durations = [];
  for (const kind of ["singing", "training"]) {
    for (const part of ["high", "mid", "low"]) {
      const file = song[kind]?.[part];
      if (!file) {
        failures.push(`${song.id} is missing ${kind}/${part}.`);
        continue;
      }
      const absolute = path.join(ROOT, "public", file.path);
      if (!existsSync(absolute)) {
        failures.push(`${file.path} does not exist.`);
        continue;
      }
      const stats = await decodeStats(ffmpeg, absolute);
      if (!stats.samples || !Number.isFinite(stats.rmsDb) || stats.rmsDb < -70) {
        failures.push(`${file.path} is silent or did not decode.`);
      }
      if (kind === "singing") {
        if (file.alignment?.version !== recipes.version) failures.push(`${file.path} is not aligned with recipe v${recipes.version}.`);
        if (recipe && file.alignment?.fingerprint !== recipeFingerprint(recipes.version, recipe, part)) failures.push(`${file.path} has a stale timing map.`);
        if (recipe && Math.abs(stats.duration - recipe.duration) > .04) failures.push(`${file.path} differs from authored duration.`);
        if (!file.rawPath || !existsSync(path.join(ROOT, "public", file.rawPath))) failures.push(`${file.path} has no preserved original.`);
        durations.push(stats.duration);
      }
      checked++;
    }
  }
  if (durations.length === 3 && Math.max(...durations) - Math.min(...durations) > 0.03) {
    failures.push(`${song.id} singing durations differ by ${(Math.max(...durations) - Math.min(...durations)).toFixed(3)}s.`);
  }
}

console.log(JSON.stringify({ songs: manifest.songs?.length || 0, tracksChecked: checked, failures }, null, 2));
if (failures.length) process.exit(1);

function decodeStats(executable, file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-nostdin", "-nostats", "-i", file,
      "-map", "0:a:0", "-af", "astats=metadata=0:reset=0",
      "-f", "null", "-",
    ];
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not decode ${file}: ${output.slice(-500)}`));
      const durationMatch = output.match(/Duration:\s*([0-9:.]+)/);
      const rmsMatch = [...output.matchAll(/RMS level dB:\s*([^\s]+)/g)].at(-1);
      const sampleMatch = [...output.matchAll(/Number of samples:\s*([^\s]+)/g)].at(-1);
      resolve({
        duration: parseClock(durationMatch?.[1] || "0"),
        rmsDb: Number(rmsMatch?.[1]),
        samples: Number(sampleMatch?.[1]),
      });
    });
  });
}

function parseClock(value) {
  const pieces = value.split(":").map(Number);
  return (pieces[0] || 0) * 3600 + (pieces[1] || 0) * 60 + (pieces[2] || 0);
}
