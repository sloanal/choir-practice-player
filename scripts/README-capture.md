# Local Dropbox audio export

## Primary workflow: export the player's audio stream

Run `sh scripts/export-dropbox-audio.sh`. This builds and launches a dedicated
Dropbox browser, walks all folders, and exports the audio stream delivered to
the player. It uses the existing FFmpeg bundled with Screen Studio to remux
audio into `.m4a` without re-encoding. No microphone, system audio, or screen
recording permission is needed for this workflow. Screen Studio itself does
not need to run. The export uses only the supplied share and its playback URLs.

The output is `recordings/Fall’26 Section Parts for LCC/`, with source folder
and track base names preserved; all audio containers use the `.m4a` extension.
These are **Dropbox playback-stream copies**, not
guaranteed byte-for-byte originals. The stream may already have been transcoded
by Dropbox; this workflow introduces no further audio encoding.

Every file is fully decoded and checked for matching duration and non-silent
audio before being promoted from `.partial.m4a`. Failed exports retry up to
three times. Completed stream exports are skipped on a rerun. The local
`capture-manifest.json` records source links, durations, peaks, sizes, and method.
Progress is logged to `.capture-cache/stream-export.log`; run
`python3 scripts/capture-status.py` for a concise status.

After completion, run `python3 scripts/verify-captures.py` to repeat the full
decode checks and write `verification.json`, including SHA-256 checksums.
The auditor uses the existing FFprobe bundled with Descript and the FFmpeg
bundled with Screen Studio. It also rejects unexpected video streams, invalid
audio samples, missing/extra files, and duration differences over 0.15 seconds.
No files are uploaded or published. Generated audio and cache are ignored by Git.

## Fallback: real-time system-audio capture

`choir-capture.swift` builds a dedicated macOS player for the choir share. It
walks the visible Dropbox folder hierarchy, plays recordings at their normal
speed, and captures only its own application's system audio with ScreenCaptureKit.
It does not use the microphone or write screen video.

The output is `recordings/Fall’26 Section Parts for LCC/`, preserving folder and
track names. These are new playback captures, not bit-for-bit copies of the
source files. Audio is stereo AAC at 48 kHz and 192 kbps (about 86 MB per hour).
Capture may add up to a small fraction of a second of silence around playback.

`capture-manifest.json` records the source URL, source and captured duration,
decoded peak amplitude, file size, completion status, and errors. A file is
promoted from `.partial.m4a` only after playback reaches the end, the encoded
file is decoded, the duration matches, and non-silent audio is confirmed.
Relaunching resumes tracks not marked complete. The recorder stops below 5 GB
free disk space or on a capture/playback/verification failure.

Build locally (no third-party dependencies):

```sh
mkdir -p .capture-cache/ChoirCapture.app/Contents/MacOS
cp scripts/choir-capture-Info.plist .capture-cache/ChoirCapture.app/Contents/Info.plist
swiftc -parse-as-library -module-cache-path /private/tmp/choir-swift-cache \
  scripts/choir-capture.swift \
  -o .capture-cache/ChoirCapture.app/Contents/MacOS/ChoirCapture
codesign --force --sign - .capture-cache/ChoirCapture.app
open .capture-cache/ChoirCapture.app
```

macOS system-audio capture permission is required for this application. Capture
is explicitly filtered to the dedicated player's own process ID; it cannot
record ChatGPT, other browsers, or unrelated applications. Top-level browsing
is restricted to the supplied Dropbox share. The browser uses an ephemeral
session rather than an existing browser profile.

Fallback progress is written to `.capture-cache/capture.log`. Output, cache files, and
compiled binaries are ignored by Git. No automatic upload or publishing occurs.
