import { useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/format";

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

  const restart = () => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    setPosition(0);
  };

  return (
    <div className="player">
      <audio
        ref={audioRef}
        src={src}
        loop={loop}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />

      <div className="transport">
        <button className="play-btn" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "►"}
        </button>
        <button
          className="restart-btn"
          onClick={restart}
          aria-label="Restart from beginning"
          title="Restart from beginning"
        >
          ⏮
        </button>
        <div className="scrub">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(position, duration || 0)}
            onChange={(e) => {
              const el = audioRef.current;
              if (el) el.currentTime = Number(e.target.value);
              setPosition(Number(e.target.value));
            }}
          />
          <div className="times">
            <span>{formatTime(position)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
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
