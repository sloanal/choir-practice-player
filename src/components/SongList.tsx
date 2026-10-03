import { useMemo, useState } from "react";
import type { PartId, Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { hasSinging, hasTraining, partsOf } from "../lib/songs";
import { PlaylistPlayer } from "./PlaylistPlayer";
import { OfflineControls } from "./OfflineControls";
import { useOnline } from "../hooks/useOnline";
import {
  offlineSupported,
  summarize,
  useOffline,
} from "../offline/offlineStore";

export function SongList({ songs, myPart }: { songs: Song[]; myPart: PartId }) {
  const [query, setQuery] = useState("");
  const offline = useOffline();
  const online = useOnline();

  const singingSongs = useMemo(
    () =>
      songs.filter(hasSinging).sort((a, b) => a.title.localeCompare(b.title)),
    [songs],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? songs.filter((s) => s.title.toLowerCase().includes(q))
      : songs;
    return [...list].sort((a, b) => a.title.localeCompare(b.title));
  }, [songs, query]);

  return (
    <div className="songlist">
      <PlaylistPlayer songs={singingSongs} myPart={myPart} />
      <OfflineControls songs={songs} scope="all" />
      <div className="search">
        <input
          type="search"
          placeholder="Search songs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <ul className="cards">
        {filtered.map((song) => {
          const saved = offlineSupported && offline.ready
            ? summarize(offline, [song]).state
            : null;
          return (
            <li key={song.id}>
              <button
                className="card"
                onClick={() => navigate({ name: "song", id: song.id })}
              >
                <span className="card-title">{song.title}</span>
                <span className="card-badges">
                  {hasSinging(song) && (
                    <span className="badge badge-sing">
                      Singing · {partsOf(song.singing).length}
                    </span>
                  )}
                  {hasTraining(song) && (
                    <span className="badge badge-learn">
                      Training · {partsOf(song.training).length}
                    </span>
                  )}
                  {saved === "saved" && (
                    <span className="badge badge-offline">✓ Offline</span>
                  )}
                  {saved === "saving" && (
                    <span className="badge badge-offline">Saving…</span>
                  )}
                  {!online && saved !== null && saved !== "saved" &&
                    saved !== "saving" && (
                    <span className="badge badge-unsaved">Not saved</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && <li className="muted">No matches.</li>}
      </ul>
    </div>
  );
}
