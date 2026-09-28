import { useMemo, useState } from "react";
import type { Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { hasSinging, hasTraining, partsOf } from "../lib/songs";

export function SongList({ songs }: { songs: Song[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? songs.filter((s) => s.title.toLowerCase().includes(q))
      : songs;
    return [...list].sort((a, b) => a.title.localeCompare(b.title));
  }, [songs, query]);

  return (
    <div className="songlist">
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
        {filtered.map((song) => (
          <li key={song.id}>
            <button className="card" onClick={() => navigate({ name: "song", id: song.id })}>
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
              </span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted">No matches.</li>}
      </ul>
    </div>
  );
}
