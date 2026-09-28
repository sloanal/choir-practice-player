# Singing-audio alignment pass — 28 September 2026

All 39 singing files across 13 song sections were rendered from preserved
originals using the revision-5 elastic timing maps. The 39 teaching recordings
were not edited. SHA-256 comparisons verified all 78 originals are unchanged.

## Editing and alignment

Waveform-envelope overlays were reviewed for all 13 trios. Broadband attacks,
spectral envelopes and bounded dynamic time warping established local timing
maps, with hand-reviewed musical-section boundaries. Pitch was held constant:
different harmony notes were not tuned to match each other.

The largest structural corrections were the two Clear Blue Morning passes,
the two Chain choruses, and the two Chain verses. Their different count-ins and
spoken breaks previously defeated a single offset/tempo correction. The low
Chain outro's spoken explanation and the middle Clear Blue Morning spoken tail
are silenced. Alternate demonstrations remain available in the originals and
teaching recordings.

Rubber Band R3 follows continuous keyframe maps inside each section. Decoded
renders are compared with their own source envelopes to measure synthesis
latency/drift, and compensated passes are rendered again from original PCM.
This does not repeatedly time-stretch a previously stretched recording.

## Verification

- 78/78 app files decode and contain audio; all 13 singing trios have the
  authored duration and current timing-map fingerprint.
- 39/39 singing tracks passed the encoded-envelope timing audit, covering
  1,325 high-correlation windows. For 34 tracks the 95th-percentile error against
  the authored map was at most 20 ms; the largest per-track 95th percentile was
  50 ms. Analysis resolution is 10 ms. These are **render-to-map measurements**,
  not a claim that every note of different harmony parts coincides.
- Synthetic tests verify unchanged identity audio, retained 440 Hz pitch under
  variable time stretching, and mapped musical attacks within 40 ms.
- Browser checks verified trio playback, isolating the middle part, restoring
  all parts, pause/resume, and seeking into the second Clear Blue Morning pass.
- All 39 current audio URLs were served successfully by the local app.
- Six JavaScript tests cover grouping, monotonic/shared maps, cache invalidation,
  shared Web Audio start time, authored zero points, and mix headroom/solo level.

Cross-voice correlation is reported separately by `scripts/audit-audio-timing.py`.
Some windows still produce large/ambiguous peaks (notably the fast middle/low
Clear Blue Morning passage); distinct harmony rhythms and repeated attacks make
these unsuitable as a universal pass/fail measure. This pass substantially
improves alignment but does not establish sample-perfect or phoneme-perfect
synchronization of independently recorded performances.

Full-volume unattenuated trios peaked above digital full scale in several songs.
The player now derives safe mix headroom from the decoded track peaks. This
prevents clipping without altering timing, pitch or normal solo level.

## Reproduction and rollback

See the README's audio setup. `npm run align` uses the committed maps and source
checksums; `npm run verify:audio` checks the complete set. The detailed acoustic
audit is generated at `.audio-work/timing-audit.json`. Raw recordings and source
caches remain untouched. The 81 superseded generated files were moved out of
the served directory into `.audio-work/previous-renders/`, where they remain
recoverable for comparison. No original audio was deleted.
