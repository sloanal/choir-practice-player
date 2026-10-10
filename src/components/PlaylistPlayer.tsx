import { useState } from "react";
import { PlayIcon } from "./PlayIcon";
import { BackTenButton, Scrubber } from "./Scrubber";
import { PART_SHORT, type PartId, type Song } from "../types";
import { type RepeatMode, usePlaylistPlayer } from "../hooks/usePlaylistPlayer";

const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: "Repeat off",
  all: "Repeat all",
  one: "Repeat one",
};

export function PlaylistPlayer(
  { songs, myPart }: { songs: Song[]; myPart: PartId },
) {
  const pl = usePlaylistPlayer(songs, myPart);
  const [showQueue, setShowQueue] = useState(false);

  if (songs.length === 0) return null;

  if (!pl.started || !pl.current) {
    return (
      <section className="playlist playlist-idle" aria-label="Singing playlist">
        <div className="playlist-intro">
          <span className="playlist-kicker">🎧 Singing playlist</span>
          <span className="muted">
            Play all {songs.length} singing tracks back to back
          </span>
        </div>
        <div className="playlist-start">
          <button
            className="btn btn-primary"
            onClick={() =>
              pl.start({ shuffle: false })}
          >
            ► Play all
          </button>
          <button
            className="btn"
            onClick={() =>
              pl.start({ shuffle: true })}
          >
            <ShuffleIcon /> Shuffle
          </button>
        </div>
      </section>
    );
  }

  const ready = pl.status === "ready";

  return (
    <section className="playlist" aria-label="Singing playlist">
      <div className="playlist-head">
        <div className="playlist-now">
          <span className="playlist-kicker">
            🎧 Singing playlist · {pl.index + 1} of {pl.queue.length}
          </span>
          <span className="playlist-title">{pl.current.title}</span>
          {pl.status === "loading" && (
            <span className="muted playlist-note">Loading…</span>
          )}
          {pl.status === "error" && (
            <span className="playlist-note playlist-error">
              Couldn’t load audio: {pl.error}
            </span>
          )}
        </div>
        <button
          className="mini"
          onClick={pl.stop}
          title="Close playlist"
          aria-label="Close playlist"
        >
          ✕
        </button>
      </div>

      <div className="transport playlist-transport">
        <button
          className="skip-btn"
          onClick={pl.prev}
          title="Previous"
          aria-label="Previous"
        >
          <PrevIcon />
        </button>
        <BackTenButton
          onClick={() => pl.seek(Math.max(0, pl.position - 10))}
          disabled={!ready}
        />
        <button
          className="play-btn"
          onClick={pl.toggle}
          aria-label={pl.playing ? "Pause" : "Play"}
        >
          {pl.playing ? "❚❚" : <PlayIcon />}
        </button>
        <button
          className="skip-btn"
          onClick={pl.next}
          disabled={!pl.hasNext}
          title="Next"
          aria-label="Next"
        >
          <NextIcon />
        </button>
        <Scrubber
          value={pl.position}
          duration={pl.duration}
          onSeek={pl.seek}
          disabled={!ready}
        />
      </div>

      <div className="controls-row">
        <button
          className={`chip chip-icon ${pl.shuffle ? "chip-on" : ""}`}
          onClick={() => pl.setShuffle(!pl.shuffle)}
          aria-pressed={pl.shuffle}
        >
          <ShuffleIcon /> Shuffle
        </button>
        <button
          className={`chip chip-icon ${pl.repeat !== "off" ? "chip-on" : ""}`}
          onClick={pl.cycleRepeat}
          title="Cycle repeat: off, all, one"
        >
          <RepeatIcon one={pl.repeat === "one"} /> {REPEAT_LABELS[pl.repeat]}
        </button>
        <span className="controls-sep" />
        <button
          className={`chip ${pl.mix === "all" ? "chip-on" : ""}`}
          onClick={() => pl.setMix("all")}
          aria-pressed={pl.mix === "all"}
        >
          All parts
        </button>
        <button
          className={`chip ${pl.mix === "mine" ? "chip-on" : ""}`}
          onClick={() => pl.setMix("mine")}
          aria-pressed={pl.mix === "mine"}
        >
          Just my part ({PART_SHORT[myPart]})
        </button>
      </div>

      <div className="controls-row playlist-volume">
        <span className="muted">Volume</span>
        <input
          className="vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={pl.volume}
          onChange={(e) => pl.setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>

      <button className="link-btn" onClick={() => setShowQueue((v) => !v)}>
        {showQueue ? "Hide" : "Show"} queue
      </button>
      {showQueue && (
        <ol className="queue">
          {pl.queue.map((song, i) => (
            <li key={song.id}>
              <button
                className={`queue-item ${
                  i === pl.index ? "queue-item-on" : ""
                }`}
                onClick={() => pl.jumpTo(i)}
                aria-current={i === pl.index ? "true" : undefined}
              >
                <span className="queue-num">
                  {i === pl.index && pl.playing ? "♪" : i + 1}
                </span>
                <span>{song.title}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M6 5h2v14H6zM20 5v14L9 12z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M16 5h2v14h-2zM4 5v14l11-7z" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"
      />
    </svg>
  );
}

function RepeatIcon({ one }: { one: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"
      />
      {one && (
        <text
          x="12"
          y="14.5"
          fontSize="8"
          fontWeight="700"
          textAnchor="middle"
          fill="currentColor"
        >
          1
        </text>
      )}
    </svg>
  );
}
