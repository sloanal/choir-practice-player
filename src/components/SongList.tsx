import { useMemo, useState } from "react";
import type { PartId, Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { hasExtras, hasSinging, hasTraining, partsOf } from "../lib/songs";
import { PlaylistPlayer } from "./PlaylistPlayer";

export function SongList({ songs, myPart }: { songs: Song[]; myPart: PartId }) {
  const [query, setQuery] = useState("");
  const hasBits = songs.some(hasExtras);

  const singingSongs = useMemo(
    () => songs.filter(hasSinging).sort((a, b) => a.title.localeCompare(b.title)),
    [songs]
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
      {hasBits && (
        <button className="bits-banner" onClick={() => navigate({ name: "bits" })}>
          <span className="bits-banner-icon">🧩</span>
          <span>
            <span className="bits-banner-title">Bits &amp; Bobs &amp; Structure</span>
            <span className="bits-banner-sub">
              Greg’s extra parts and song structure notes
            </span>
          </span>
          <span className="bits-banner-arrow">→</span>
        </button>
      )}
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
                {hasExtras(song) && <span className="badge badge-bits">Bits &amp; Bobs</span>}
              </span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted">No matches.</li>}
      </ul>
    </div>
  );
}
