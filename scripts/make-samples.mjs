#!/usr/bin/env node
// Generate synthetic demo audio + manifest so the player works locally
// without Dropbox. Each part gets a different pitch and a different amount
// of leading silence, so onset alignment, solo/mute and looping are testable.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SAMPLE_RATE = 44100;

// pitch in Hz + leading silence in seconds, per part
const PARTS = {
  high: { freq: 659.25, lead: 0.35 }, // E5
  mid: { freq: 523.25, lead: 0.0 }, // C5
  low: { freq: 392.0, lead: 0.6 }, // G4
};

const SONGS = [
  { id: "because-the-night", title: "Because the night", dur: 8 },
  { id: "blinding-lights", title: "Blinding Lights", dur: 7 },
  { id: "fix-you-chorus", title: "Fix You (Chorus)", dur: 6 },
];

function synth({ freq, lead, dur, warble }) {
  const total = Math.floor(SAMPLE_RATE * dur);
  const leadN = Math.floor(SAMPLE_RATE * lead);
  const out = new Float32Array(total);
  for (let i = leadN; i < total; i++) {
    const t = (i - leadN) / SAMPLE_RATE;
    const vib = warble ? 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t) : 1;
    // Gentle attack/release envelope + slow pulsing so it's pleasant.
    const env = Math.min(1, t / 0.05) * Math.min(1, (dur - lead - t) / 0.1);
    const pulse = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.8 * t);
    let s = 0;
    s += Math.sin(2 * Math.PI * freq * vib * t);
    s += 0.3 * Math.sin(2 * Math.PI * 2 * freq * vib * t); // overtone
    out[i] = 0.28 * env * pulse * s;
  }
  return out;
}

function encodeWav(samples) {
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buffer;
}

async function main() {
  const songs = [];
  for (const song of SONGS) {
    const singing = {};
    const training = {};
    for (const [part, cfg] of Object.entries(PARTS)) {
      // Singing: layered harmony (short leading silence differences).
      const singBuf = encodeWav(
        synth({ freq: cfg.freq, lead: cfg.lead, dur: song.dur, warble: true })
      );
      const singRel = `audio/${song.id}/singing-${part}.wav`;
      await write(singRel, singBuf);
      singing[part] = { path: singRel, name: `${song.title} - Singing - ${part}.wav`, size: singBuf.length };

      // Training: a single steady reference tone.
      const learnBuf = encodeWav(
        synth({ freq: cfg.freq, lead: 0.1, dur: song.dur + 2, warble: false })
      );
      const learnRel = `audio/${song.id}/training-${part}.wav`;
      await write(learnRel, learnBuf);
      training[part] = { path: learnRel, name: `${song.title} - LEARN - ${part}.wav`, size: learnBuf.length };
    }
    songs.push({ id: song.id, title: song.title, singing, training });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: "sample data (npm run sample)",
    songs,
  };
  await write("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  console.log(`Wrote ${songs.length} demo songs to public/. Run \`npm run dev\`.`);
}

async function write(rel, buf) {
  const dest = path.join(ROOT, "public", rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
