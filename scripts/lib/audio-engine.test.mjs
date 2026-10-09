import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Execute the actual TypeScript engine with small media/decoder fakes, not a
// copy of the mix/scheduling logic. No browser, network or user recordings.
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

const SR = 44100;

function fakeBuffer(samples, seconds = 4) {
  const length = SR * seconds;
  const data = new Float32Array(length);
  data.set(samples);
  return {
    duration: seconds,
    length,
    sampleRate: SR,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

/** Installs fakes; returns the created media elements and object-URL blobs. */
function installFakes(samples) {
  const media = [];
  const blobs = new Map();
  let nextUrl = 0;
  const original = {
    window: globalThis.window,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    fetch: globalThis.fetch,
  };
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${nextUrl++}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => blobs.delete(url);
  class FakeOfflineAudioContext {
    decodeAudioData() {
      return Promise.resolve(fakeBuffer(samples));
    }
  }
  globalThis.window = {
    OfflineAudioContext: FakeOfflineAudioContext,
    document: {
      createElement() {
        const listeners = {};
        const el = {
          paused: true,
          ended: false,
          muted: false,
          loop: false,
          currentTime: 0,
          playbackRate: 1,
          defaultPlaybackRate: 1,
          attrs: {},
          plays: 0,
          _src: "",
          get src() {
            return this._src;
          },
          set src(v) {
            this._src = v;
            this.attrs.src = v;
            this.paused = true;
            this.currentTime = 0;
            this.playbackRate = this.defaultPlaybackRate;
            queueMicrotask(() => this.emit("loadedmetadata"));
          },
          setAttribute(k, v) {
            this.attrs[k] = v;
          },
          getAttribute(k) {
            return this.attrs[k] ?? null;
          },
          removeAttribute(k) {
            delete this.attrs[k];
            if (k === "src") this._src = "";
          },
          addEventListener(type, fn) {
            (listeners[type] ??= []).push(fn);
          },
          removeEventListener(type, fn) {
            listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
          },
          emit(type) {
            for (const fn of [...(listeners[type] ?? [])]) fn();
          },
          load() {},
          play() {
            this.plays++;
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
  const restore = () => {
    globalThis.window = original.window;
    globalThis.fetch = original.fetch;
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  };
  return { media, blobs, restore };
}

/** First left-channel sample of the WAV the element is currently playing. */
async function firstSample(el, blobs) {
  const bytes = await blobs.get(el.src).arrayBuffer();
  return new DataView(bytes).getInt16(44, true) / 0x7fff;
}

const settle = () => new Promise((r) => setTimeout(r, 200));

test("plays one pre-mixed stream through a media element, not Web Audio", async () => {
  const { media, blobs, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    assert.equal(media.length, 1);
    assert.equal(media[0].attrs.playsinline, "");
    assert.equal(window.AudioContext, undefined, "no live AudioContext needed");
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const el = media[0];
    assert.equal(blobs.get(el.src).type, "audio/wav");
    assert.ok((await blobs.get(el.src).size) > SR * 4 * 4, "whole song, stereo");

    await player.play();
    assert.equal(el.paused, false);
    el.currentTime = 1.5;
    assert.equal(player.getPosition(), 1.5);

    player.setPlaybackRate(.75);
    assert.equal(el.playbackRate, .75);
    player.pause();
    assert.equal(el.paused, true);
    assert.equal(player.getPosition(), 1.5);

    let ended = 0;
    player.onEnded = () => ended++;
    await player.play();
    el.ended = true;
    el.emit("pause");
    el.emit("ended");
    assert.equal(ended, 1, "natural end is reported once");
    assert.equal(player.isPlaying, false);
    player.dispose();
    assert.equal(el.paused, true);
    assert.equal(blobs.size, 0, "mix URL released");
  } finally {
    restore();
  }
});

test("authored zero point, clean trio mix and full-level solo", async () => {
  const { media, blobs, restore } = installFakes([.8, -.8, .1]);
  try {
    const player = new LayeredPlayer();
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const el = media[0];
    const trio = await firstSample(el, blobs);
    assert.ok(trio <= .950001 && trio > .94, `sum cannot clip (${trio})`);

    player.toggleSolo("mid");
    await settle();
    const solo = await firstSample(el, blobs);
    assert.ok(Math.abs(solo - .8) < 1e-3, "isolated track retains normal level");

    player.setMasterVolume(.5);
    await settle();
    assert.ok(Math.abs((await firstSample(el, blobs)) - .4) < 1e-3);
    player.dispose();
  } finally {
    restore();
  }
});

test("mix changes swap in at the current position and keep playing", async () => {
  const { media, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const el = media[0];
    await player.play();
    el.currentTime = 2;
    const before = el.src;
    player.setMuted("low", true);
    await settle();
    assert.notEqual(el.src, before, "re-rendered");
    assert.equal(el.currentTime, 2, "resumed where it was");
    assert.equal(el.paused, false, "still playing");
    assert.equal(player.isPlaying, true);
    player.dispose();
  } finally {
    restore();
  }
});

test("loop renders just the region and loops it natively", async () => {
  const { media, blobs, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    await player.load([{ id: "a", url: "a", onset: 0 }]);
    const el = media[0];
    player.setLoopRegion(1, 2);
    player.setLoopEnabled(true);
    await settle();
    assert.equal(el.loop, true);
    const size = blobs.get(el.src).size;
    assert.equal(size, 44 + SR * 1 * 2 * 2, "one second, stereo 16-bit");
    await player.play();
    assert.equal(el.currentTime, 0, "playhead moved into the loop");
    el.currentTime = .25;
    assert.equal(player.getPosition(), 1.25);
    player.dispose();
  } finally {
    restore();
  }
});

test("unlock grants a gesture silently without starting playback", async () => {
  const { media, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    await player.unlock();
    const el = media[0];
    assert.equal(el.plays, 1);
    assert.equal(el.paused, true);
    assert.equal(el.muted, false);
    el.emit("play");
    assert.equal(player.isPlaying, false, "the unlock's own play is ignored");
    player.dispose();
  } finally {
    restore();
  }
});
