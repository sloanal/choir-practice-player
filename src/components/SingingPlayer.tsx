import { useMemo, useState } from "react";
import { PART_LABELS, PART_SHORT, type PartId, type Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { partsOf, singingInputs } from "../lib/songs";
import { useLayeredPlayer } from "../hooks/useLayeredPlayer";
import { formatTime } from "../lib/format";

const RATES = [0.75, 0.9, 1, 1.1, 1.25];

export function SingingPlayer({ song, myPart }: { song: Song; myPart: PartId }) {
  const parts = partsOf(song.singing);
  const inputs = useMemo(
    () => singingInputs(song),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song.id]
  );

  const player = useLayeredPlayer(inputs);
  const [showAlign, setShowAlign] = useState(false);

  const pct = player.duration > 0 ? (player.position / player.duration) * 100 : 0;
  const loopStartPct =
    player.duration > 0 ? (player.loop.start / player.duration) * 100 : 0;
  const loopEndPct =
    player.duration > 0 ? (player.loop.end / player.duration) * 100 : 0;

  const anySolo = player.tracks.some((t) => t.soloed);

  return (
    <div className="playerpage">
      <button className="back" onClick={() => navigate({ name: "song", id: song.id })}>
        ← {song.title}
      </button>
      <div className="playerpage-head">
        <h1 className="song-heading">{song.title}</h1>
        <span className="mode-tag mode-sing">🎧 Singing</span>
      </div>

      {player.status === "loading" && <p className="muted">Loading & aligning parts…</p>}
      {player.status === "error" && (
        <p className="muted">Couldn’t load audio: {player.error}</p>
      )}

      {player.status === "ready" && (
        <>
          <div className="transport">
            <button
              className="play-btn"
              onClick={player.toggle}
              aria-label={player.playing ? "Pause" : "Play"}
            >
              {player.playing ? "❚❚" : "►"}
            </button>
            <div className="scrub">
              <div className="scrub-track">
                {player.loop.on && (
                  <div
                    className="loop-region"
                    style={{
                      left: `${loopStartPct}%`,
                      width: `${Math.max(0, loopEndPct - loopStartPct)}%`,
                    }}
                  />
                )}
                <div className="scrub-fill" style={{ width: `${pct}%` }} />
                <input
                  type="range"
                  min={0}
                  max={player.duration || 0}
                  step={0.01}
                  value={Math.min(player.position, player.duration || 0)}
                  onChange={(e) => player.seek(Number(e.target.value))}
                />
              </div>
              <div className="times">
                <span>{formatTime(player.position)}</span>
                <span>{formatTime(player.duration)}</span>
              </div>
            </div>
          </div>

          <div className="quick-actions">
            <button
              className={`chip ${!anySolo ? "chip-on" : ""}`}
              onClick={player.clearSolo}
              aria-pressed={!anySolo}
            >
              All parts
            </button>
            {parts.includes(myPart) && (
              <button
                className={`chip ${
                  anySolo && player.tracks.find((t) => t.id === myPart)?.soloed
                    ? "chip-on"
                    : ""
                }`}
                onClick={() => player.soloOnly(myPart)}
                aria-pressed={
                  anySolo && !!player.tracks.find((t) => t.id === myPart)?.soloed
                }
              >
                Just my part ({PART_SHORT[myPart]})
              </button>
            )}
          </div>

          <div className="mixer">
            {parts.map((p) => {
              const t = player.tracks.find((x) => x.id === p)!;
              const dimmed = anySolo && !t.soloed;
              return (
                <div key={p} className={`track ${dimmed ? "track-dim" : ""}`}>
                  <div className="track-head">
                    <span className="track-name">
                      {PART_LABELS[p]}
                      {p === myPart && <span className="you-dot" title="Your part" />}
                    </span>
                    <div className="track-btns">
                      <button
                        className={`mini ${t.soloed ? "mini-solo" : ""}`}
                        onClick={() => player.toggleSolo(p)}
                        title="Solo"
                        aria-pressed={t.soloed}
                      >
                        S
                      </button>
                      <button
                        className={`mini ${t.muted ? "mini-mute" : ""}`}
                        onClick={() => player.setMuted(p, !t.muted)}
                        title="Mute"
                        aria-pressed={t.muted}
                      >
                        M
                      </button>
                    </div>
                  </div>
                  <input
                    className="vol"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={t.volume}
                    onChange={(e) => player.setVolume(p, Number(e.target.value))}
                  />
                  {showAlign && (
                    <div className="align-row">
                      <span className="muted">nudge</span>
                      <button className="mini" onClick={() => nudge(player, p, t.onset, t.detectedOnset, -0.02)}>
                        −
                      </button>
                      <span className="align-val">
                        {Math.round((t.onset - t.detectedOnset) * 1000)}ms
                      </span>
                      <button className="mini" onClick={() => nudge(player, p, t.onset, t.detectedOnset, +0.02)}>
                        +
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="controls-row">
            <button
              className={`chip ${player.loop.on ? "chip-on" : ""}`}
              onClick={() => player.setLoopEnabled(!player.loop.on)}
              aria-pressed={player.loop.on}
            >
              ↻ Loop
            </button>
            <button
              className="chip"
              onClick={() =>
                player.setLoopRegion(player.position, player.loop.end)
              }
              title="Set loop start to current position"
            >
              Set A
            </button>
            <button
              className="chip"
              onClick={() => player.setLoopRegion(player.loop.start, player.position)}
              title="Set loop end to current position"
            >
              Set B
            </button>
            <button
              className="chip"
              onClick={() => player.setLoopRegion(0, player.duration)}
              title="Loop the whole song"
            >
              Full
            </button>
          </div>

          <div className="controls-row">
            <span className="muted">Speed</span>
            {RATES.map((r) => (
              <button
                key={r}
                className={`chip ${player.rate === r ? "chip-on" : ""}`}
                onClick={() => player.setRate(r)}
                aria-pressed={player.rate === r}
              >
                {r}×
              </button>
            ))}
          </div>

          <button className="link-btn" onClick={() => setShowAlign((v) => !v)}>
            {showAlign ? "Hide" : "Show"} alignment fine-tune
          </button>
        </>
      )}
    </div>
  );
}

function nudge(
  player: ReturnType<typeof useLayeredPlayer>,
  part: PartId,
  onset: number,
  detected: number,
  delta: number
) {
  const currentDelta = onset - detected;
  player.setOnsetDelta(part, currentDelta + delta);
}
