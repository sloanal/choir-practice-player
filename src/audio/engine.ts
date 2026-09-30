/**
 * LayeredPlayer: plays several audio tracks in tight sync using a single
 * AudioContext, with per-track gain (volume / mute / solo), onset alignment,
 * region looping, seeking and variable playback rate.
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
  bytes: ArrayBuffer;
  buffer: AudioBuffer;
  gain: GainNode;
  peak: number;
  /** Detected leading silence + manual nudge, in seconds (>= 0). */
  onset: number;
  detectedOnset: number;
  source: AudioBufferSourceNode | null;
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

export class LayeredPlayer {
  private ctx: AudioContext;
  private master: GainNode;
  private rebuiltContextForMobile = false;
  private masterVolume = 1;
  private tracks: Track[] = [];

  private playing = false;
  private startCtxTime = 0;
  private startPos = 0;
  private pausedPos = 0;
  private rate = 1;

  private loopOn = false;
  private loopStart = 0;
  private loopEnd = 0;

  private loadToken = 0;

  onEnded: (() => void) | null = null;

  constructor() {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  /**
   * Load a set of tracks, replacing any previously loaded ones. Can be called
   * repeatedly to reuse one AudioContext across songs. Resolves `false` when a
   * newer `load()` call superseded this one.
   */
  async load(
    inputs: TrackInput[],
    fetchBytes: (url: string) => Promise<ArrayBuffer> = fetchArrayBuffer
  ): Promise<boolean> {
    const token = ++this.loadToken;
    this.stopSources();
    this.playing = false;
    this.pausedPos = 0;
    this.loopOn = false;
    this.loopStart = 0;
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = [];

    const ctx = this.ctx;
    const loaded = await Promise.all(
      inputs.map(async (input) => {
        const bytes = await fetchBytes(input.url);
        const buffer = await ctx.decodeAudioData(bytes);
        const onset = input.onset ?? detectOnset(buffer);
        const gain = ctx.createGain();
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
        }
        const track: Track = {
          id: input.id,
          bytes,
          buffer,
          gain,
          peak,
          onset,
          detectedOnset: onset,
          source: null,
          volume: 1,
          muted: false,
          soloed: false,
        };
        return track;
      })
    );
    if (token !== this.loadToken || ctx !== this.ctx) return false;
    for (const t of loaded) t.gain.connect(this.master);
    this.tracks = loaded;
    this.loopEnd = this.duration;
    this.applyGains();
    return true;
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
    if (!this.playing) return this.pausedPos;
    const raw = this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.rate;
    if (this.loopOn) {
      const len = this.loopEnd - this.loopStart;
      if (len > 0 && raw >= this.loopEnd) {
        return this.loopStart + ((raw - this.loopStart) % len);
      }
    }
    return Math.min(raw, this.duration);
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
   * Unlock audio output. Must be started synchronously inside a user gesture
   * on mobile Safari; `play()` does this itself, but callers that load audio
   * after the gesture should call it first.
   */
  async unlock(): Promise<void> {
    if (isIOSLike() && !this.rebuiltContextForMobile) {
      await this.rebuildContextForMobileGesture();
    }
    if (this.ctx.state === "suspended") {
      this.primeOutputForMobileSafari();
      void this.ctx.resume();
    }
  }

  async play(): Promise<void> {
    if (this.playing) return;
    await this.unlock();
    if (this.playing || this.tracks.length === 0) return;
    let from = this.pausedPos;
    if (from >= this.duration - 0.02) from = this.loopOn ? this.loopStart : 0;
    this.startSources(from);
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedPos = this.getPosition();
    this.stopSources();
    this.playing = false;
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(pos: number): void {
    const clamped = Math.max(0, Math.min(pos, this.duration));
    if (this.playing) {
      this.stopSources();
      this.startSources(clamped);
    } else {
      this.pausedPos = clamped;
    }
  }

  setLoopEnabled(on: boolean): void {
    this.loopOn = on;
    this.restartIfPlaying();
  }

  setLoopRegion(start: number, end: number): void {
    this.loopStart = Math.max(0, Math.min(start, this.duration));
    this.loopEnd = Math.max(this.loopStart + 0.05, Math.min(end, this.duration));
    this.restartIfPlaying();
  }

  getLoop(): { on: boolean; start: number; end: number } {
    return { on: this.loopOn, start: this.loopStart, end: this.loopEnd };
  }

  setPlaybackRate(rate: number): void {
    const pos = this.getPosition();
    this.rate = rate;
    if (this.playing) {
      this.stopSources();
      this.startSources(pos);
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.applyGains();
  }

  setVolume(id: string, v: number): void {
    const t = this.track(id);
    if (!t) return;
    t.volume = v;
    this.applyGains();
  }

  setMuted(id: string, muted: boolean): void {
    const t = this.track(id);
    if (!t) return;
    t.muted = muted;
    this.applyGains();
  }

  toggleSolo(id: string): void {
    const t = this.track(id);
    if (!t) return;
    t.soloed = !t.soloed;
    this.applyGains();
  }

  clearSolo(): void {
    for (const t of this.tracks) t.soloed = false;
    this.applyGains();
  }

  /** Adjust a track's alignment by `deltaSeconds` relative to its detected onset. */
  setOnsetDelta(id: string, deltaSeconds: number): void {
    const t = this.track(id);
    if (!t) return;
    const pos = this.getPosition();
    t.onset = Math.max(0, t.detectedOnset + deltaSeconds);
    this.loopEnd = Math.min(this.loopEnd, this.duration);
    if (this.playing) {
      this.stopSources();
      this.startSources(pos);
    }
  }

  dispose(): void {
    this.stopSources();
    void this.ctx.close();
  }

  // --- internals ---

  private track(id: string): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  private applyGains(): void {
    const anySolo = this.tracks.some((t) => t.soloed);
    let summedPeaks = 0;
    for (const t of this.tracks) {
      const audible = anySolo ? t.soloed : !t.muted;
      t.gain.gain.value = audible ? t.volume : 0;
      if (audible) summedPeaks += t.peak * t.volume;
    }
    // Aligned piano/vocal attacks can sum above full scale. Reserve headroom
    // without changing timing or compressing the recordings; solo stays full.
    this.master.gain.value = this.masterVolume * Math.min(1, .95 / Math.max(.95, summedPeaks));
  }

  private restartIfPlaying(): void {
    if (!this.playing) return;
    const pos = this.getPosition();
    this.stopSources();
    this.startSources(pos);
  }

  private primeOutputForMobileSafari(): void {
    const buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master);
    try {
      src.start(0);
    } catch {
      // Older mobile Safari builds can throw if the context was already unlocked.
    }
  }

  private async rebuildContextForMobileGesture(): Promise<void> {
    this.rebuiltContextForMobile = true;
    const oldCtx = this.ctx;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.primeOutputForMobileSafari();
    void this.ctx.resume();

    this.tracks = await Promise.all(
      this.tracks.map(async (track) => {
        const buffer = await this.ctx.decodeAudioData(track.bytes.slice(0));
        const gain = this.ctx.createGain();
        gain.connect(this.master);
        return { ...track, buffer, gain, source: null };
      })
    );
    this.applyGains();
    void oldCtx.close();
  }

  private startSources(from: number): void {
    const now = this.ctx.currentTime;
    this.startCtxTime = now;
    this.startPos = from;
    this.pausedPos = from;
    this.playing = true;

    for (const t of this.tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.playbackRate.value = this.rate;
      src.connect(t.gain);

      if (this.loopOn) {
        src.loop = true;
        src.loopStart = t.onset + this.loopStart;
        src.loopEnd = t.onset + this.loopEnd;
      }

      const bufferStart = t.onset + from;
      if (bufferStart < t.buffer.duration) {
        src.start(now, Math.max(0, bufferStart));
        t.source = src;
        if (!this.loopOn) {
          src.onended = () => {
            if (t.source === src) t.source = null;
            if (this.playing && this.tracks.every((x) => x.source === null)) {
              this.handleNaturalEnd();
            }
          };
        }
      } else {
        t.source = null;
      }
    }
  }

  private handleNaturalEnd(): void {
    if (!this.playing) return;
    this.playing = false;
    this.pausedPos = this.duration;
    this.stopSources();
    this.onEnded?.();
  }

  private stopSources(): void {
    for (const t of this.tracks) {
      if (t.source) {
        t.source.onended = null;
        try {
          t.source.stop();
        } catch {
          /* already stopped */
        }
        t.source.disconnect();
        t.source = null;
      }
    }
  }
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.arrayBuffer();
}

function isIOSLike(): boolean {
  const nav = window.navigator;
  if (!nav) return false;
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
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
