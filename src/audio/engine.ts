/**
 * LayeredPlayer: plays several audio tracks in tight sync, with per-track gain
 * (volume / mute / solo), onset alignment, region looping, seeking and
 * variable playback rate.
 *
 * Output model
 * ------------
 * The tracks are decoded once, then mixed sample-accurately into a single WAV
 * that plays through one ordinary <audio> element. Mixing in advance (rather
 * than live through an AudioContext) means playback goes through the
 * platform's media pipeline, the same one music apps use. On iOS, Web Audio
 * output stutters on some Bluetooth receivers such as car stereos, and stops
 * when the screen locks; a media element handles both like any music app.
 * Changing the mix re-renders it (a few tens of milliseconds for a song) and
 * swaps it in at the current position.
 *
 * Alignment model
 * ---------------
 * The recordings of each harmony part are not trimmed to the same start, so
 * each track has an "onset" (seconds of leading silence before singing
 * begins). We build a shared timeline where t = 0 means "the moment everyone
 * starts singing". A track's buffer time is therefore `onset + t`.
 */

export interface TrackInput {
  id: string;
  url: string;
  /** A known authored timeline origin. Omit to auto-detect leading silence. */
  onset?: number;
}

interface Track {
  id: string;
  buffer: AudioBuffer;
  peak: number;
  /** Detected leading silence + manual nudge, in seconds (>= 0). */
  onset: number;
  detectedOnset: number;
  volume: number;
  muted: boolean;
  soloed: boolean;
}

export interface TrackState {
  id: string;
  volume: number;
  muted: boolean;
  soloed: boolean;
  onset: number;
  detectedOnset: number;
  duration: number;
}

/** Every rendered part is 44.1 kHz; decoding at that rate avoids resampling. */
const MIX_SAMPLE_RATE = 44100;
/** Lets a volume-slider drag settle before re-rendering the mix. */
const SLIDER_RENDER_DELAY_MS = 120;
/** How closely the incoming mix must match the outgoing one at handover. */
const SYNC_TOLERANCE_SECONDS = 0.01;
/** Give up waiting for the incoming mix to start (it then cuts over). */
const STARTUP_TIMEOUT_MS = 2000;
/** Stop fine-tuning and switch anyway, close enough, after this long. */
const CONVERGE_TIMEOUT_MS = 1500;
/** Time over which a speed tweak closes the offset. */
const CONVERGE_SECONDS = 0.2;
/** Fade at loop edges so the wrap-around does not click. */
const LOOP_FADE_SECONDS = 0.005;

export class LayeredPlayer {
  private decoder: BaseAudioContext;
  /**
   * Two elements: one plays the current mix while the other loads the next
   * one, so a mix change hands over without a pause in the sound.
   */
  private els: [HTMLAudioElement, HTMLAudioElement];
  private active = 0;
  private mixUrl: string | null = null;
  /** The active element holds a mix of the current tracks. */
  private mixReady = false;
  /** Timeline range the current mix covers: [loop start, loop end) or all. */
  private mixStart = 0;
  private mixEnd = 0;
  private mixLoops = false;
  private masterVolume = 1;
  private tracks: Track[] = [];

  private playing = false;
  private pausedPos = 0;
  private rate = 1;

  private loopOn = false;
  private loopStart = 0;
  private loopEnd = 0;

  private loadToken = 0;
  private renderToken = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** A new mix is loading; seeks meanwhile must carry over to it. */
  private rendering = false;
  private pendingSeek: number | null = null;
  private disposed = false;
  /** Learned delay between play() and sound actually flowing, in seconds. */
  private startupLead = 0.05;
  /** Recent mix handovers, for the ?debug readout. */
  readonly handovers: string[] = [];

  onEnded: (() => void) | null = null;

  constructor() {
    this.decoder = createDecoder();
    this.els = [this.createElement(), this.createElement()];
  }

  /**
   * Load a set of tracks, replacing any previously loaded ones. Can be called
   * repeatedly to reuse one media element across songs. Resolves `false` when
   * a newer `load()` call superseded this one.
   */
  async load(
    inputs: TrackInput[],
    fetchBytes: (url: string) => Promise<ArrayBuffer> = fetchArrayBuffer
  ): Promise<boolean> {
    const token = ++this.loadToken;
    this.cancelScheduledRender();
    this.playing = false;
    this.mixReady = false;
    for (const el of this.els) el.pause();
    this.pausedPos = 0;
    this.loopOn = false;
    this.loopStart = 0;
    this.tracks = [];

    const loaded = await Promise.all(
      inputs.map(async (input) => {
        const bytes = await fetchBytes(input.url);
        const buffer = await decode(this.decoder, bytes);
        const onset = input.onset ?? detectOnset(buffer);
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let i = 0; i < samples.length; i++) {
            peak = Math.max(peak, Math.abs(samples[i]));
          }
        }
        const track: Track = {
          id: input.id,
          buffer,
          peak,
          onset,
          detectedOnset: onset,
          volume: 1,
          muted: false,
          soloed: false,
        };
        return track;
      }),
    );
    if (token !== this.loadToken || this.disposed) return false;
    this.tracks = loaded;
    this.loopEnd = this.duration;
    await this.renderNow();
    return token === this.loadToken && !this.disposed;
  }

  /** Length of the shared, onset-aligned timeline. */
  get duration(): number {
    let max = 0;
    for (const t of this.tracks) {
      max = Math.max(max, t.buffer.duration - t.onset);
    }
    return max;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get playbackRate(): number {
    return this.rate;
  }

  getPosition(): number {
    if (!this.playing || !this.mixReady) return this.pausedPos;
    return Math.min(this.mixStart + this.el.currentTime, this.duration);
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map((t) => ({
      id: t.id,
      volume: t.volume,
      muted: t.muted,
      soloed: t.soloed,
      onset: t.onset,
      detectedOnset: t.detectedOnset,
      duration: t.buffer.duration,
    }));
  }

  /**
   * Allow later, gesture-less playback (e.g. auto-advancing a playlist). Must
   * be called synchronously inside a user gesture on mobile Safari: a media
   * element that has been played once from a tap may play freely afterwards.
   */
  async unlock(): Promise<void> {
    if (this.playing) return;
    for (const el of this.els) prime(el);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    // Synchronous, so the tap that called us counts as the gesture for both.
    prime(this.standby);
    if (this.tracks.length === 0) {
      prime(this.el);
      return;
    }
    let from = this.pausedPos;
    if (from >= this.duration - 0.02) from = this.loopOn ? this.loopStart : 0;
    this.moveTo(from);
    this.playing = true;
    // Still loading: the mix starts itself once it is ready.
    if (!this.mixReady) return;
    const played = this.el.play();
    try {
      await played;
    } catch (err) {
      // A pause right after aborts it harmlessly; only a refusal matters.
      if ((err as { name?: string })?.name === "NotAllowedError") {
        this.playing = false;
      }
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedPos = this.getPosition();
    this.playing = false;
    for (const el of this.els) el.pause();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(pos: number): void {
    this.moveTo(Math.max(0, Math.min(pos, this.duration)));
  }

  setLoopEnabled(on: boolean): void {
    if (on === this.loopOn) return;
    const pos = this.getPosition();
    this.loopOn = on;
    this.pausedPos = pos;
    this.rerangeMix();
  }

  setLoopRegion(start: number, end: number): void {
    this.loopStart = Math.max(0, Math.min(start, this.duration));
    this.loopEnd = Math.max(
      this.loopStart + 0.05,
      Math.min(end, this.duration),
    );
    if (this.loopOn) this.rerangeMix();
  }

  getLoop(): { on: boolean; start: number; end: number } {
    return { on: this.loopOn, start: this.loopStart, end: this.loopEnd };
  }

  setPlaybackRate(rate: number): void {
    this.rate = rate;
    this.el.defaultPlaybackRate = rate;
    this.el.playbackRate = rate;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.scheduleRender(SLIDER_RENDER_DELAY_MS);
  }

  setVolume(id: string, v: number): void {
    const t = this.track(id);
    if (!t) return;
    t.volume = v;
    this.scheduleRender(SLIDER_RENDER_DELAY_MS);
  }

  setMuted(id: string, muted: boolean): void {
    const t = this.track(id);
    if (!t) return;
    t.muted = muted;
    this.scheduleRender();
  }

  toggleSolo(id: string): void {
    const t = this.track(id);
    if (!t) return;
    t.soloed = !t.soloed;
    this.scheduleRender();
  }

  clearSolo(): void {
    for (const t of this.tracks) t.soloed = false;
    this.scheduleRender();
  }

  /** Adjust a track's alignment by `deltaSeconds` relative to its detected onset. */
  setOnsetDelta(id: string, deltaSeconds: number): void {
    const t = this.track(id);
    if (!t) return;
    t.onset = Math.max(0, t.detectedOnset + deltaSeconds);
    this.loopEnd = Math.min(this.loopEnd, this.duration);
    this.scheduleRender();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduledRender();
    this.renderToken++;
    this.playing = false;
    for (const el of this.els) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    if (this.mixUrl) URL.revokeObjectURL(this.mixUrl);
    this.mixUrl = null;
  }

  // --- internals ---

  private get el(): HTMLAudioElement {
    return this.els[this.active];
  }

  private get standby(): HTMLAudioElement {
    return this.els[1 - this.active];
  }

  private createElement(): HTMLAudioElement {
    const el = window.document.createElement("audio");
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    setPreservesPitch(el, false);
    el.addEventListener("ended", () => {
      if (el === this.el) this.handleNaturalEnd();
    });
    // Lock-screen, headphone and car controls act on the element directly.
    el.addEventListener("pause", () => {
      if (el !== this.el || !this.playing || el.ended) return;
      this.pausedPos = this.getPosition();
      this.playing = false;
    });
    el.addEventListener("play", () => {
      if (el !== this.el || this.playing || el.paused) return;
      if (!this.mixReady) return;
      this.pausedPos = this.getPosition();
      this.playing = true;
    });
    return el;
  }

  private track(id: string): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  /** Per-track gains, including the shared headroom and master volume. */
  private mixGains(): number[] {
    const anySolo = this.tracks.some((t) => t.soloed);
    let summedPeaks = 0;
    const gains = this.tracks.map((t) => {
      const audible = anySolo ? t.soloed : !t.muted;
      const gain = audible ? t.volume : 0;
      summedPeaks += t.peak * gain;
      return gain;
    });
    // Aligned piano/vocal attacks can sum above full scale. Reserve headroom
    // without changing timing or compressing the recordings; solo stays full.
    const master = this.masterVolume *
      Math.min(1, .95 / Math.max(.95, summedPeaks));
    return gains.map((g) => g * master);
  }

  /** Position the playhead, keeping it inside the loop while looping. */
  private moveTo(pos: number): void {
    if (this.loopOn && (pos < this.loopStart || pos >= this.loopEnd)) {
      pos = this.loopStart;
    }
    this.pausedPos = pos;
    if (this.rendering) this.pendingSeek = pos;
    if (this.mixReady) {
      this.el.currentTime = mixTime(pos, this.mixStart, this.mixEnd, this.mixLoops);
    }
  }

  /**
   * The loop changed which stretch of the timeline the mix covers, so the
   * element's clock no longer maps to it: swap immediately (the swap starts
   * synchronously) so a seek right after lands on the new mix.
   */
  private rerangeMix(): void {
    if (this.tracks.length === 0 || this.disposed) return;
    void this.renderNow().catch(() => undefined);
  }

  /**
   * Re-render shortly. Several calls in a row (e.g. clear solo, then solo one
   * part) coalesce into one render; sliders wait a little longer for the
   * drag to settle.
   */
  private scheduleRender(delay = 0): void {
    if (this.tracks.length === 0 || this.disposed) return;
    this.cancelScheduledRender();
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.renderNow().catch(() => undefined);
    }, delay);
  }

  private cancelScheduledRender(): void {
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  /**
   * Mix the current settings into the standby element, then make it the
   * active one. While playing, the old mix keeps sounding until the new one
   * is running in step with it, so the change is heard without a gap.
   */
  private async renderNow(): Promise<void> {
    this.cancelScheduledRender();
    const token = ++this.renderToken;
    const stale = () => token !== this.renderToken || this.disposed;
    this.rendering = true;
    const loop = this.loopOn;
    const start = loop ? this.loopStart : 0;
    const end = loop ? this.loopEnd : this.duration;
    const wav = mixToWav(
      this.tracks,
      this.mixGains(),
      start,
      end,
      loop ? LOOP_FADE_SECONDS : 0,
    );
    const url = URL.createObjectURL(wav);

    const next = this.standby;
    next.pause();
    next.muted = true;
    next.loop = loop;
    next.src = url;
    try {
      await whenLoaded(next);
    } catch (err) {
      URL.revokeObjectURL(url);
      if (!stale()) this.rendering = false;
      throw err;
    }
    if (stale()) {
      URL.revokeObjectURL(url);
      return;
    }
    next.defaultPlaybackRate = this.rate;
    next.playbackRate = this.rate;

    let inStep = false;
    if (this.playing && this.mixReady) {
      inStep = await this.startInStep(next, start, end, loop, stale);
      if (stale()) {
        URL.revokeObjectURL(url);
        return;
      }
    }

    const old = this.el;
    const oldUrl = this.mixUrl;
    this.rendering = false;
    this.pendingSeek = null;
    this.active = 1 - this.active;
    this.mixUrl = url;
    this.mixStart = start;
    this.mixEnd = end;
    this.mixLoops = loop;
    this.mixReady = true;
    if (inStep && this.playing) {
      // Same tick: the new mix takes over exactly where the old one was.
      next.muted = false;
      old.muted = true;
      old.pause();
      old.muted = false;
    } else {
      old.pause();
      if (!this.playing) next.pause();
      next.muted = false;
      this.moveTo(this.pausedPos);
      if (this.playing) {
        next.play()?.catch(() => {
          // The OS refused (no gesture yet); the next tap on Play retries.
        });
      }
    }
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }

  /**
   * Start `next` (muted) at the playhead and bring it into step with the
   * active element. Resolves true once `next` is audibly running (in step, or
   * as close as it got), false if it never started; a jump (the loop or a
   * seek moved the playhead) needs no matching.
   *
   * iOS reports "playing" a moment before sound actually flows, so we wait
   * for the clock to move, and correct any offset by briefly speeding up or
   * slowing down the muted element rather than seeking, which would restart
   * that startup delay.
   */
  private async startInStep(
    next: HTMLAudioElement,
    start: number,
    end: number,
    loop: boolean,
    stale: () => boolean,
  ): Promise<boolean> {
    const drift = () => {
      const len = end - start;
      let d = this.getPosition() - (start + next.currentTime);
      if (loop && len > 0) d = ((d % len) + len * 1.5) % len - len / 2;
      return d;
    };
    const alive = () => !stale() && this.playing;
    // A seek while this mix loaded moves the playhead: start there instead.
    const seek = this.pendingSeek;
    const pos = seek ?? this.getPosition();
    const jump = seek !== null || pos < start || pos >= end;
    const target = seek ??
      (jump ? start : pos + this.startupLead * this.rate);
    const t0 = mixTime(target, start, end, loop);
    next.currentTime = t0;
    const begun = now();
    try {
      await next.play();
    } catch {
      return false;
    }
    const running = await pollUntil(
      () => !alive() || Math.abs(next.currentTime - t0) > 0.02,
      STARTUP_TIMEOUT_MS,
    );
    if (!running || !alive()) return false;
    const startup = (now() - begun) / 1000;

    if (jump) {
      // Recheck: another seek may have arrived while it started.
      if (this.pendingSeek !== null && this.pendingSeek !== target) {
        next.currentTime = mixTime(this.pendingSeek, start, end, loop);
      }
      this.logHandover(`jump, started in ${ms(startup)}`);
      return true;
    }

    // How far our head start missed by: learn it for next time.
    const initial = drift();
    this.startupLead = Math.max(0, Math.min(.5, this.startupLead + initial));
    const deadline = now() + CONVERGE_TIMEOUT_MS;
    let d = initial;
    while (alive() && Math.abs(d) > SYNC_TOLERANCE_SECONDS && now() < deadline) {
      // Close the gap over ~0.2 s; muted, so the pitch change is unheard.
      next.playbackRate = this.rate *
        Math.max(.5, Math.min(2, 1 + d / CONVERGE_SECONDS));
      await sleep(15);
      d = drift();
    }
    next.playbackRate = this.rate;
    this.logHandover(
      `started in ${ms(startup)}, off by ${ms(initial)}, ` +
        `switched ${ms(d)} apart`,
    );
    return alive();
  }

  private logHandover(line: string): void {
    this.handovers.push(line);
    if (this.handovers.length > 8) this.handovers.shift();
  }

  private handleNaturalEnd(): void {
    if (!this.playing || this.mixLoops) return;
    this.playing = false;
    this.pausedPos = this.duration;
    this.onEnded?.();
  }
}

/**
 * Sum the tracks over the timeline range [from, to) into a 16-bit stereo WAV.
 * All buffers share one sample rate (they come from the same decoder).
 */
function mixToWav(
  tracks: Track[],
  gains: number[],
  from: number,
  to: number,
  edgeFade: number,
): Blob {
  const sampleRate = tracks[0]?.buffer.sampleRate ?? MIX_SAMPLE_RATE;
  const frames = Math.max(1, Math.round((to - from) * sampleRate));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  tracks.forEach((t, i) => {
    const gain = gains[i];
    if (!(gain > 0)) return;
    const offset = Math.round((t.onset + from) * sampleRate);
    const n = Math.min(frames, t.buffer.length - offset);
    if (n <= 0) return;
    const l = t.buffer.getChannelData(0);
    const r = t.buffer.numberOfChannels > 1 ? t.buffer.getChannelData(1) : l;
    for (let s = 0; s < n; s++) {
      left[s] += l[offset + s] * gain;
      right[s] += r[offset + s] * gain;
    }
  });
  const fade = Math.min(Math.floor(edgeFade * sampleRate), frames >> 1);
  for (let s = 0; s < fade; s++) {
    const g = s / fade;
    left[s] *= g;
    right[s] *= g;
    left[frames - 1 - s] *= g;
    right[frames - 1 - s] *= g;
  }
  return encodeWav([left, right], sampleRate);
}

function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const count = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * count * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // Typed-array writes are several times faster than DataView per sample.
  // WAV is little-endian, as is every platform this runs on.
  const pcm = new Int16Array(view.buffer, 44, frames * count);
  for (let c = 0; c < count; c++) {
    const data = channels[c];
    for (let s = 0, i = c; s < frames; s++, i += count) {
      const v = data[s];
      pcm[i] = v >= 1 ? 0x7fff : v <= -1 ? -0x8000 : v * 0x7fff;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

let silentWavUrl: string | null = null;

/** A short silent clip to give the element a source before a mix exists. */
function silentUrl(): string {
  silentWavUrl ??= URL.createObjectURL(
    encodeWav([new Float32Array(MIX_SAMPLE_RATE / 10)], MIX_SAMPLE_RATE),
  );
  return silentWavUrl;
}

/** Where timeline position `pos` falls within a mix covering [start, end). */
function mixTime(pos: number, start: number, end: number, loop: boolean): number {
  const len = Math.max(0, end - start);
  const t = pos - start;
  if (loop && len > 0) return ((t % len) + len) % len;
  return Math.max(0, Math.min(t, len));
}

/**
 * Play then pause in the same tick: silent, but on mobile Safari it marks the
 * element as started by the user, so later gesture-less play() is allowed.
 */
function prime(el: HTMLAudioElement): void {
  if (!el.getAttribute("src")) el.src = silentUrl();
  const muted = el.muted;
  el.muted = true;
  const played = el.play();
  el.pause();
  el.muted = muted;
  played?.catch(() => {
    // The pause above aborts it; the gesture has still been granted.
  });
}

const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (seconds: number) => `${Math.round(seconds * 1000)}ms`;

/** Polls `done` every 10 ms; resolves false if it is still false at timeout. */
async function pollUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (!done()) {
    if (now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

function whenLoaded(el: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      el.removeEventListener("loadedmetadata", done);
      el.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      el.removeEventListener("loadedmetadata", done);
      el.removeEventListener("error", failed);
      reject(new Error("Could not play the mixed audio"));
    };
    el.addEventListener("loadedmetadata", done);
    el.addEventListener("error", failed);
  });
}

/** Rate changes speed up / slow down the recording, pitch included. */
function setPreservesPitch(el: HTMLAudioElement, on: boolean): void {
  const media = el as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  media.preservesPitch = on;
  media.webkitPreservesPitch = on;
}

/** Decoding only: this context never produces sound. */
function createDecoder(): BaseAudioContext {
  const Ctx = window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  return new Ctx(2, MIX_SAMPLE_RATE, MIX_SAMPLE_RATE);
}

function decode(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  // Older WebKit only supports the callback form.
  return new Promise((resolve, reject) => {
    const result = ctx.decodeAudioData(bytes, resolve, reject);
    result?.then(resolve, reject);
  });
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Find where audible content begins, in seconds. Uses an adaptive RMS
 * threshold relative to the track's peak, then backs off slightly so the
 * attack of the first note is not clipped.
 */
function detectOnset(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const len = buffer.length;

  // Peak across channels to set an adaptive threshold.
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i += 64) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return 0;

  const threshold = Math.max(0.015, peak * 0.06);
  const winSize = Math.max(1, Math.floor(sr * 0.02)); // 20 ms windows

  for (let start = 0; start + winSize <= len; start += winSize) {
    let sumSq = 0;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < start + winSize; i++) {
        const v = data[i];
        sumSq += v * v;
      }
    }
    const rms = Math.sqrt(sumSq / (winSize * channels));
    if (rms > threshold) {
      const backoff = 0.03 * sr; // keep 30 ms of run-up
      const onsetSample = Math.max(0, start - backoff);
      return onsetSample / sr;
    }
  }
  return 0;
}
