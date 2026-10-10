# Choir Practice Player

A web app for practicing three‑part harmony (Highers / Mids / Lowers). Pick a
song, then choose **Training** (your teacher's teaching recording, one part at a
time) or **Singing** (all three parts layered together in sync, with per‑part
volume, solo/mute, looping and speed control).

Files can be imported from a shared Dropbox folder, then committed with the
verified app assets so the whole thing deploys as a static site to GitHub Pages.

## How it works

```
Dropbox shared folder  ──(local sync/import)──────────►  npm run sync
   Highers/ Lowers/ Mids/                                   │  downloads audio →  public/audio/
     ├─ LEARN - Greg teaching/  (training)                  │  writes            →  public/manifest.json
     └─ Singing only/           (singing)                   ▼
                                                        npm run build  ──►  GitHub Pages (static)
```

- **Grouping**: files are matched into songs by a normalized title (handling
  `–` vs `-`, `Mids`/`MIDS`, odd spacing, and abbreviations like `w` → `with`).
- **Sync/alignment**: the singing takes have different starts, local tempo drift,
  spoken breaks and alternate passes. `npm run align` renders reviewed musical
  sections with **non-linear, pitch-preserving timing maps**, using Rubber Band's
  R3 engine. All three parts share one authored timeline. Original/training
  recordings are preserved, and fingerprinted filenames prevent stale audio.
  There's still a **Show alignment fine‑tune** control to nudge any part by
  ±20 ms while rehearsing.
- **Playback**: the singing player decodes the three parts and mixes them
  sample‑accurately into one WAV in the browser, which plays through a single
  `<audio>` element. Going through the platform's media pipeline (rather than
  live Web Audio output) keeps playback smooth over Bluetooth receivers such as
  car stereos and lets it continue with the screen locked. Changing a part's
  volume, mute/solo, alignment or the loop re-renders the mix (well under a
  second) into a second `<audio>` element, which starts muted in step with the
  first and takes over in the same instant, so the sound never pauses. Peak-aware mix headroom
  prevents the three aligned parts from clipping together; solo playback keeps
  its normal level.
  Because all audio is served same‑origin (baked into
  the deployed site), there are no CORS issues.

- **Offline**: a service worker (`public/sw.js`) caches the app shell, and
  **Save offline** (per song, or **Save all songs** on the home page) stores
  that song's singing and training audio in Cache Storage. Saved files are
  tagged with their manifest hash; files the manifest drops or changes are
  deleted on the next load. The worker is only registered in production
  builds, so use `npm run build && npm run preview` to try it locally.

## Local development

```bash
npm install
npm run sample   # generate synthetic demo audio + manifest (no Dropbox needed)
npm run dev      # http://localhost:5173
```

`npm run sample` writes a few demo songs to `public/` so you can try the UI
immediately. To use the real songs locally, run the sync (see below) instead.

With the verified local exports in `recordings/`, build the complete real set:

```bash
npm run import-recordings
npm run verify:audio
```

### Audio rendering setup

Install FFmpeg and Python 3.9+ first. Set `FFMPEG_PATH` if FFmpeg is not in one
of the standard locations. Rendering needs NumPy and Rubber Band 3+ (the pinned
local build below uses 4.0.0 and requires a C++ compiler):

```bash
python3 -m venv .audio-venv
.audio-venv/bin/pip install -r scripts/audio-requirements.txt
bash scripts/setup-audio-tools.sh
npm run align
npm run verify:audio
.audio-venv/bin/python scripts/test-audio-renderer.py
MPLCONFIGDIR=/tmp/choir-matplotlib NUMBA_CACHE_DIR=/tmp/choir-numba \
  .audio-venv/bin/python scripts/audit-audio-timing.py
```

`AUDIO_PYTHON` and `RUBBERBAND_LIBRARY` override the local runtime/library.
The build downloads source code only; recordings are processed locally.

The committed `scripts/audio-alignment.json` contains the reviewed source/output
anchors and original-file SHA-256 checksums. A changed recording deliberately
fails closed instead of silently applying an old map. The deployment workflow
must use these exact source exports, or the maps must be re-reviewed against new
Dropbox downloads before deployment. The current exports came from Dropbox's
playback streams and may differ byte-for-byte from a direct file download.

To deliberately redo the analysis, `scripts/refine-audio.py` generates a
**candidate**, not a live manifest, in `.audio-work/`. It uses broad-band attacks,
spectral envelopes and bounded dynamic time warping at 20 ms resolution; it does
not try to match different harmony pitches. Inspect its waveform overlays and
section boundaries before promoting a new map. Its coarse starting points are
preserved in `scripts/audio-alignment-baseline.json`.

Current elastic-alignment edits:

- Removes mismatched count-ins/explanations before the singing.
- Aligns both passes of Clear Blue Morning independently (including the higher
  part's alternate register), both Chain choruses, and both Chain verses.
- Keeps the first complete low take of Fix You's chorus and Lay Down; their
  teaching recordings still contain the alternate demonstrations.
- Silences the low Chain outro's spoken octave explanation without shifting the
  later musical entrance.
- Uses continuous elastic stretching within each musical section, short edge
  fades, common gaps, and calibration of the stretcher's measured timing offset.

`verify:audio` checks every song and Bits & Bobs file, map fingerprints and
trio durations. The
offline timing audit separately compares decoded AAC envelopes with their own
source maps and reports confident cross-voice attack matches. Those partial
matches are diagnostics, **not proof every harmony note is simultaneous**;
different parts have intentional rhythmic differences and sustained notes.

## Connecting Dropbox

The folder is shared by your instructor, so the app uses the Dropbox API to read
and download it. You'll create a tiny Dropbox "app" (free) to get credentials.

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) →
   **Create app**.
   - API: **Scoped access**
   - Access type: **Full Dropbox**
   - Name it anything (e.g. `choir-player`).
2. On the app's **Permissions** tab, enable these scopes and **Submit**:
   - `sharing.read`
   - `files.content.read`
   - `files.metadata.read`
3. On the **Settings** tab, copy the **App key** and **App secret**.
4. Get a durable refresh token:
   ```bash
   npm run auth
   ```
   Paste the App key/secret, open the printed URL, approve access, and paste the
   code back. It prints the three values you need.

### Run the sync locally (optional)

```bash
export DROPBOX_APP_KEY=...
export DROPBOX_APP_SECRET=...
export DROPBOX_REFRESH_TOKEN=...
npm run sync      # downloads audio to public/audio + writes public/manifest.json
npm run align     # trim + tempo-correct the singing trios without shifting pitch
npm run verify:audio
npm run dev
```

(For a quick one‑off you can instead `export DROPBOX_ACCESS_TOKEN=...` with a
short‑lived token from the App Console's "Generate access token" button.)

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub
   Actions**.
3. Run the **Deploy** workflow (Actions tab → Run workflow), or just push to
   `main`.

The workflow (`.github/workflows/deploy.yml`) runs on every push and on demand.
It verifies the committed audio manifest, builds, and deploys the static app.

## New songs

Just drop them in the Dropbox folder as usual, then run the local sync/import and
alignment pipeline before committing the changed `public/audio` files and
`public/manifest.json`. If a song's file names differ so much that its singing
and training versions don't group together, add an entry to
`scripts/song-aliases.json` mapping the odd normalized title to the canonical
one.

Recordings in the **Bits&Bobs & Structure** folder become each song's "Bits &
Bobs" page. A file is attached to every song section whose title starts with
the name before `B&B` or ` - ` (so "The Chain B&B - structure" appears on all
three Chain sections); files matching no song are shown on the overview page.
Per-part recordings also serve as training for a song that has none.

## Project layout

```
src/
  audio/engine.ts          multi-track engine: decode, mix to one stream, loop, seek
  components/              SongList, SongChooser, TrainingPlayer, SingingPlayer, SimpleAudioPlayer
  hooks/                   manifest loading, hash routing, layered-player controller, "my part"
scripts/
  sync-dropbox.mjs         lists the shared link, downloads audio, writes manifest
  make-samples.mjs         synthetic demo audio for local dev
  dropbox-auth.mjs         one-time refresh-token helper
  lib/grouping.mjs         filename → song grouping logic
.github/workflows/deploy.yml
```
