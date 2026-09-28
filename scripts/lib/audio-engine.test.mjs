import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Execute the actual TypeScript engine with small Web Audio fakes, not a copy
// of the mix/scheduling logic. No browser, network or user recordings required.
const source = fs.readFileSync(new URL("../../src/audio/engine.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { LayeredPlayer } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("shared start time, authored zero point, clean trio mix and full-level solo", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  let context;
  class FakeAudioContext {
    currentTime = 10;
    state = "running";
    destination = {};
    gains = [];
    sources = [];
    constructor() { context = this; }
    createGain() {
      const node = { gain: { value: 1 }, connect() {} };
      this.gains.push(node); return node;
    }
    async decodeAudioData() {
      return { duration: 4, numberOfChannels: 1, getChannelData: () => new Float32Array([.8, -.8, .1]) };
    }
    createBufferSource() {
      const node = { playbackRate: { value: 1 }, connect() {}, stop() {}, disconnect() {}, start(...args) { this.started = args; } };
      this.sources.push(node); return node;
    }
    async resume() {}
    async close() {}
  }
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  try {
    const player = new LayeredPlayer();
    await player.load(["high", "mid", "low"].map(id => ({ id, url: id, onset: 0 })));
    assert.ok(context.gains[0].gain.value * 2.4 <= .950001, "sum cannot clip");
    await player.play();
    assert.equal(context.sources.length, 3);
    for (const node of context.sources) assert.deepEqual(node.started, [10, 0]);
    player.toggleSolo("mid");
    assert.equal(context.gains[0].gain.value, 1, "isolated track retains normal level");
    player.setMasterVolume(.5);
    assert.equal(context.gains[0].gain.value, .5);
    player.dispose();
  } finally {
    globalThis.window = originalWindow; globalThis.fetch = originalFetch;
  }
});
