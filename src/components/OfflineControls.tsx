import type { ReactNode } from "react";
import type { Song } from "../types";
import { formatBytes } from "../lib/format";
import {
  cancelSongs,
  offlineSupported,
  removeSongs,
  saveSongs,
  summarize,
  useOffline,
} from "../offline/offlineStore";

/**
 * Save / remove offline copies of one song (`scope="song"`) or the whole
 * library (`scope="all"`).
 */
export function OfflineControls(
  { songs, scope }: { songs: Song[]; scope: "song" | "all" },
) {
  const snap = useOffline();
  if (!offlineSupported || songs.length === 0) return null;

  const { state, bytes, total } = summarize(snap, songs);
  const pct = total > 0 ? Math.floor((bytes / total) * 100) : 0;
  const all = scope === "all";

  const remove = () => {
    if (
      all &&
      !window.confirm("Remove all offline audio from this device?")
    ) return;
    void removeSongs(songs);
  };

  let status: string;
  let action: ReactNode = null;
  let secondary: ReactNode = null;

  if (!snap.ready) {
    status = "Checking offline storage…";
  } else if (state === "saving") {
    status = `Saving for offline… ${pct}% (${formatBytes(bytes)} of ${
      formatBytes(total)
    })`;
    secondary = (
      <button className="chip" onClick={() => cancelSongs(songs)}>
        Cancel
      </button>
    );
  } else if (state === "saved") {
    status = all
      ? `All ${songs.length} songs saved for offline · ${formatBytes(total)}`
      : `Saved for offline · ${formatBytes(total)}`;
    secondary = (
      <button className="chip" onClick={remove}>
        {all ? "Remove all" : "Remove"}
      </button>
    );
  } else {
    const remaining = total - bytes;
    status = state === "partial"
      ? `${formatBytes(bytes)} of ${formatBytes(total)} saved for offline`
      : all
      ? "Listen without a connection"
      : "Play this song without a connection";
    action = (
      <button className="btn" onClick={() => void saveSongs(songs)}>
        ⬇ {state === "partial"
          ? "Save the rest"
          : all
          ? "Save all songs"
          : "Save offline"} · {formatBytes(remaining)}
      </button>
    );
    if (state === "partial") {
      secondary = (
        <button className="chip" onClick={remove}>
          {all ? "Remove all" : "Remove"}
        </button>
      );
    }
  }

  return (
    <section
      className={`offline offline-${state}`}
      aria-label="Offline audio"
    >
      <div className="offline-info">
        <span className="offline-status">
          {state === "saved" ? "✓ " : ""}
          {status}
        </span>
        {snap.error && state !== "saving" && (
          <span className="offline-error">{snap.error}</span>
        )}
        {state === "saving" && (
          <div
            className="offline-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="offline-actions">
        {action}
        {secondary}
      </div>
    </section>
  );
}
