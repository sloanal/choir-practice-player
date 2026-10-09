import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Execute the actual TypeScript engine with small Web Audio fakes, not a copy
// of the mix/scheduling logic. No browser, network or user recordings required.
const source = fs.readFileSync(
  new URL("../../src/audio/engine.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { LayeredPlayer } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("iOS playback uses the media audio session so the silent switch is ignored", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  class FakeAudioContext {
    currentTime = 0;
    state = "running";
    destination = {};
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    createBuffer() {
      return {};
    }
    async decodeAudioData() {
      return {
        duration: 4,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([.5]),
      };
    }
    createBufferSource() {
      return {
        playbackRate: { value: 1 },
        connect() {},
        stop() {},
        disconnect() {},
        start() {},
      };
    }
    async resume() {}
    async close() {}
  }
  const media = [];
  const audioSession = { type: "auto" };
  globalThis.window = {
    AudioContext: FakeAudioContext,
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
      audioSession,
    },
    document: {
      createElement() {
        const el = {
          paused: true,
          attrs: {},
          setAttribute(k, v) {
            this.attrs[k] = v;
          },
          removeAttribute() {},
          load() {},
          play() {
            this.paused = false;
            return Promise.resolve();
          },
          pause() {
            this.paused = true;
          },
        };
        media.push(el);
        return el;
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  try {
    const player = new LayeredPlayer();
    assert.equal(audioSession.type, "playback");
    await player.load([{ id: "a", url: "a", onset: 0 }]);
    audioSession.type = "auto";
    await player.play();
    assert.equal(audioSession.type, "playback");
    assert.equal(media.length, 1);
    assert.equal(media[0].loop, true);
    assert.equal(
      media[0].paused,
      false,
      "silent media element keeps the playback session alive",
    );
    player.pause();
    assert.equal(media[0].paused, true);
    await player.play();
    assert.equal(media.length, 1, "keep-alive element is reused");
    assert.equal(media[0].paused, false);
    player.dispose();
    assert.equal(media[0].paused, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("shared start time, authored zero point, clean trio mix and full-level solo", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  let context;
  class FakeAudioContext {
    currentTime = 10;
    state = "running";
    destination = {};
    gains = [];
    sources = [];
    constructor(options) {
      this.options = options;
      context = this;
    }
    createGain() {
      const node = { gain: { value: 1 }, connect() {} };
      this.gains.push(node);
      return node;
    }
    async decodeAudioData() {
      return {
        duration: 4,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([.8, -.8, .1]),
      };
    }
    createBufferSource() {
      const node = {
        playbackRate: { value: 1 },
        connect() {},
        stop() {},
        disconnect() {},
        start(...args) {
          this.started = args;
        },
      };
      this.sources.push(node);
      return node;
    }
    async resume() {}
    async close() {}
  }
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  try {
    const player = new LayeredPlayer();
    assert.equal(
      context.options?.latencyHint,
      "playback",
      "large output buffer so Bluetooth output does not underrun",
    );
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    assert.ok(context.gains[0].gain.value * 2.4 <= .950001, "sum cannot clip");
    await player.play();
    assert.equal(context.sources.length, 3);
    for (const node of context.sources) assert.deepEqual(node.started, [10, 0]);
    player.toggleSolo("mid");
    assert.equal(
      context.gains[0].gain.value,
      1,
      "isolated track retains normal level",
    );
    player.setMasterVolume(.5);
    assert.equal(context.gains[0].gain.value, .5);
    player.dispose();
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
