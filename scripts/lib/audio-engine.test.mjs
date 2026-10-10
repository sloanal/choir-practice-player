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
/**
 * `liveClock` makes currentTime advance in real time while playing, after
 * `startupMs` of reporting "playing" with a still clock (as iOS does).
 */
function installFakes(samples, { liveClock = false, startupMs = 0 } = {}) {
  const media = [];
  const blobs = new Map();
  const events = [];
  let srcSeq = 0;
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
          _time: 0,
          _since: null,
          get currentTime() {
            if (!liveClock || this._since === null) return this._time;
            const ran = Math.max(0, performance.now() - this._since - startupMs);
            return this._time + (ran / 1000) * this.playbackRate;
          },
          set currentTime(v) {
            this._time = v;
            if (this._since !== null) this._since = performance.now();
          },
          _rate: 1,
          get playbackRate() {
            return this._rate;
          },
          set playbackRate(v) {
            // Speed changes apply from now on, not to time already played.
            if (this._since !== null && performance.now() - this._since >= startupMs) {
              this._time = this.currentTime;
              this._since = performance.now() - startupMs;
            }
            this._rate = v;
          },
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
            this.seq = ++srcSeq;
            this.paused = true;
            this._time = 0;
            this._since = null;
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
          seq: 0,
          emit(type) {
            for (const fn of [...(listeners[type] ?? [])]) fn();
          },
          load() {},
          play() {
            this.plays++;
            events.push(["play", media.indexOf(this), this.muted]);
            if (this.paused) this._since = performance.now();
            this.paused = false;
            return Promise.resolve();
          },
          pause() {
            if (!this.paused) events.push(["pause", media.indexOf(this)]);
            if (!this.paused) this._time = this.currentTime;
            this._since = null;
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
  // The element holding the newest mix is the one the player uses.
  const active = () => media.reduce((a, b) => (b.seq > a.seq ? b : a));
  return { media, blobs, events, active, restore };
}

/** First left-channel sample of the WAV the element is currently playing. */
async function firstSample(el, blobs) {
  const bytes = await blobs.get(el.src).arrayBuffer();
  return new DataView(bytes).getInt16(44, true) / 0x7fff;
}

const settle = () => new Promise((r) => setTimeout(r, 200));

test("plays one pre-mixed stream through a media element, not Web Audio", async () => {
  const { media, blobs, active, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    assert.equal(media.length, 2, "current mix + the next one loading");
    assert.equal(media[0].attrs.playsinline, "");
    assert.equal(window.AudioContext, undefined, "no live AudioContext needed");
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const el = active();
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
    const mixUrl = el.src;
    player.dispose();
    assert.ok(media.every((m) => m.paused));
    assert.equal(blobs.has(mixUrl), false, "mix URL released");
  } finally {
    restore();
  }
});

test("authored zero point, clean trio mix and full-level solo", async () => {
  const { blobs, active, restore } = installFakes([.8, -.8, .1]);
  try {
    const player = new LayeredPlayer();
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const trio = await firstSample(active(), blobs);
    assert.ok(trio <= .950001 && trio > .94, `sum cannot clip (${trio})`);

    player.toggleSolo("mid");
    await settle();
    const solo = await firstSample(active(), blobs);
    assert.ok(Math.abs(solo - .8) < 1e-3, "isolated track retains normal level");

    player.setMasterVolume(.5);
    await settle();
    assert.ok(Math.abs((await firstSample(active(), blobs)) - .4) < 1e-3);
    player.dispose();
  } finally {
    restore();
  }
});

test("mix changes hand over to a second element without a gap", async () => {
  // iOS-like: "playing" 150 ms before the clock (and the sound) gets going.
  const { media, events, active, restore } = installFakes([.5], {
    liveClock: true,
    startupMs: 150,
  });
  try {
    const player = new LayeredPlayer();
    await player.load(
      ["high", "mid", "low"].map((id) => ({ id, url: id, onset: 0 })),
    );
    const old = active();
    await player.play();
    await new Promise((r) => setTimeout(r, 200));
    events.length = 0;
    // "Just my part": two calls, one render.
    player.clearSolo();
    player.toggleSolo("mid");
    // Sample like an ear: some element must be sounding (unmuted, clock
    // moving) throughout, and the position must never jump.
    let silentSamples = 0;
    let last = player.getPosition();
    let lastAt = performance.now();
    let maxJump = 0;
    const until = performance.now() + 1500;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
      const at = performance.now();
      const sounding = media.some((m) => !m.paused && !m.muted &&
        m._since !== null && performance.now() - m._since >= 150);
      if (!sounding) silentSamples++;
      const pos = player.getPosition();
      maxJump = Math.max(maxJump, Math.abs(pos - last - (at - lastAt) / 1000));
      last = pos;
      lastAt = at;
    }
    assert.equal(silentSamples, 0, "never silent while switching");
    assert.ok(maxJump < .05, `position continuous (max jump ${maxJump})`);
    const next = active();
    assert.notEqual(next, old, "new mix plays from the other element");
    assert.equal(next.paused, false);
    assert.equal(next.muted, false);
    assert.equal(next.playbackRate, 1, "speed tweak undone");
    assert.equal(old.paused, true);
    assert.equal(old.muted, false, "left ready for the next handover");
    const started = events.findIndex(([e, i]) => e === "play" && media[i] === next);
    assert.equal(events[started][2], true, "new mix starts muted");
    assert.equal(events.filter(([e]) => e === "play").length, 1, "one render");
    assert.equal(player.isPlaying, true);
    assert.match(player.handovers.at(-1), /switched -?\d+ms apart/);
    const apart = Number(player.handovers.at(-1).match(/(-?\d+)ms apart/)[1]);
    assert.ok(Math.abs(apart) <= 10, player.handovers.at(-1));

    player.pause();
    const pausedAt = player.getPosition();
    player.setMuted("low", true);
    await settle();
    assert.equal(active(), old, "paused changes alternate too");
    assert.equal(old.paused, true, "and stay paused");
    assert.ok(Math.abs(old.currentTime - pausedAt) < 1e-9);
    player.dispose();
  } finally {
    restore();
  }
});

test("loop renders just the region and loops it natively", async () => {
  const { blobs, active, restore } = installFakes([.5]);
  try {
    const player = new LayeredPlayer();
    await player.load([{ id: "a", url: "a", onset: 0 }]);
    player.setLoopRegion(1, 2);
    player.setLoopEnabled(true);
    await settle();
    const el = active();
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
    for (const el of media) {
      assert.equal(el.plays, 1, "both elements get the gesture");
      assert.equal(el.paused, true);
      assert.equal(el.muted, false);
    }
    const el = media[0];
    el.emit("play");
    assert.equal(player.isPlaying, false, "the unlock's own play is ignored");
    player.dispose();
  } finally {
    restore();
  }
});

test("a seek while a new mix loads carries over to it", async () => {
  const { active, restore } = installFakes([.5], { liveClock: true });
  try {
    const player = new LayeredPlayer();
    await player.load([{ id: "a", url: "a", onset: 0 }]);
    player.setLoopRegion(1, 2);
    player.setLoopEnabled(true);
    await settle();
    await player.play();
    player.setLoopEnabled(false);
    player.seek(3.5);
    await settle();
    assert.equal(active().loop, false);
    const pos = player.getPosition();
    assert.ok(pos >= 3.5 && pos < 3.8, `seek not lost to the loop mix (${pos})`);
    player.dispose();
  } finally {
    restore();
  }
});
