import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/format";

/** Finger travel (px) before a press counts as a drag rather than a tap. */
const DRAG_SLOP = 4;
/** How long to keep showing a released position while the player catches up. */
const SETTLE_MS = 600;
const KEY_STEP = 5;

/**
 * A touch-first seek bar, modelled on the iOS Music scrubber: grab it anywhere
 * (no tiny thumb to hit), drag sideways to preview the time, release to seek.
 * Seeking once on release keeps the audio engine from restarting on every
 * pixel of movement. Vertical swipes are left to the page so it still scrolls.
 */
export function Scrubber({
  value,
  duration,
  onSeek,
  disabled = false,
  children,
}: {
  value: number;
  duration: number;
  onSeek: (pos: number) => void;
  disabled?: boolean;
  /** Overlays drawn on the bar, e.g. a loop region. */
  children?: ReactNode;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [settle, setSettle] = useState<number | null>(null);

  // Hold the released position until the player reports it (or gives up), so
  // the thumb doesn't flick back to the old time for a frame.
  useEffect(() => {
    if (settle === null) return;
    if (Math.abs(value - settle) < 0.5) {
      setSettle(null);
      return;
    }
    const t = setTimeout(() => setSettle(null), SETTLE_MS);
    return () => clearTimeout(t);
  }, [value, settle]);

  const max = duration > 0 ? duration : 0;
  const shown = Math.min(drag ?? settle ?? value, max);
  const pct = max > 0 ? (shown / max) * 100 : 0;

  const posAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(1, f)) * max;
  };

  const commit = (pos: number) => {
    setSettle(pos);
    onSeek(pos);
  };

  const inactive = disabled || max <= 0;

  return (
    <div className="scrub">
      <div
        ref={barRef}
        className={`scrubber ${drag !== null ? "scrubber-active" : ""}`}
        role="slider"
        tabIndex={inactive ? -1 : 0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${formatTime(shown)} of ${formatTime(max)}`}
        aria-disabled={inactive || undefined}
        onPointerDown={(e) => {
          if (inactive || (e.pointerType === "mouse" && e.button !== 0)) return;
          press.current = { id: e.pointerId, x: e.clientX, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          // A mouse can't be mistaken for a scroll, so start straight away.
          if (e.pointerType === "mouse") setDrag(posAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || p.id !== e.pointerId) return;
          if (!p.moved && Math.abs(e.clientX - p.x) < DRAG_SLOP) return;
          p.moved = true;
          setDrag(posAt(e.clientX));
        }}
        onPointerUp={(e) => {
          const p = press.current;
          if (!p || p.id !== e.pointerId) return;
          press.current = null;
          setDrag(null);
          // A tap jumps there; a drag lands where the finger lifted.
          commit(posAt(e.clientX));
        }}
        onPointerCancel={() => {
          // The browser took the gesture over (e.g. a vertical scroll).
          press.current = null;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (inactive) return;
          let next: number | null = null;
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            next = shown - KEY_STEP;
          } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            next = shown + KEY_STEP;
          } else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = max;
          if (next === null) return;
          e.preventDefault();
          commit(Math.max(0, Math.min(next, max)));
        }}
      >
        <div className="scrubber-rail">
          {children}
          <div className="scrubber-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="scrubber-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className={`times ${drag !== null ? "times-active" : ""}`}>
        <span>{formatTime(shown)}</span>
        <span>{formatTime(max)}</span>
      </div>
    </div>
  );
}

/** Jump back a few seconds — handy for re-hearing the bar you just missed. */
export function BackTenButton(
  { onClick, disabled = false }: { onClick: () => void; disabled?: boolean },
) {
  return (
    <button
      className="restart-btn back10-btn"
      onClick={onClick}
      disabled={disabled}
      aria-label="Back 10 seconds"
      title="Back 10 seconds"
    >
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 3.5v3.7h3.7"
        />
        <text
          x="12.4"
          y="15.4"
          fontSize="7.5"
          fontWeight="700"
          textAnchor="middle"
          fill="currentColor"
        >
          10
        </text>
      </svg>
    </button>
  );
}
