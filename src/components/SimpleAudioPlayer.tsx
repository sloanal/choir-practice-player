import { useEffect, useRef, useState } from "react";
import { PlayIcon } from "./PlayIcon";
import { BackTenButton, Scrubber } from "./Scrubber";

const RATES = [0.75, 0.9, 1, 1.1, 1.25];

export function SimpleAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = rate;
  }, [rate, src]);

  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, [src]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (pos: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = pos;
    setPosition(pos);
  };

  return (
    <div className="player">
      <audio
        ref={audioRef}
        src={src}
        loop={loop}
        preload="auto"
        onPlay={(e) => {
          // Pages like Bits & Bobs show several players; only one should sound.
          for (const other of document.querySelectorAll<HTMLAudioElement>(".player audio")) {
            if (other !== e.currentTarget) other.pause();
          }
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />

      <div className="transport">
        <button
          className="play-btn"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : <PlayIcon />}
        </button>
        <button
          className="restart-btn"
          onClick={() => seek(0)}
          aria-label="Restart from beginning"
          title="Restart from beginning"
        >
          ⏮
        </button>
        <BackTenButton onClick={() => seek(Math.max(0, position - 10))} />
        <Scrubber value={position} duration={duration} onSeek={seek} />
      </div>

      <div className="controls-row">
        <button
          className={`chip ${loop ? "chip-on" : ""}`}
          onClick={() => setLoop((v) => !v)}
          aria-pressed={loop}
        >
          ↻ Loop
        </button>
        <div className="speed">
          <span className="muted">Speed</span>
          {RATES.map((r) => (
            <button
              key={r}
              className={`chip ${rate === r ? "chip-on" : ""}`}
              onClick={() => setRate(r)}
              aria-pressed={rate === r}
            >
              {r}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
