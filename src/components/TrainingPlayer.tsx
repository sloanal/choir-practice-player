import { useState } from "react";
import { PART_LABELS, type PartId, type Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { partsOf, resolveUrl } from "../lib/songs";
import { SimpleAudioPlayer } from "./SimpleAudioPlayer";

export function TrainingPlayer({ song, myPart }: { song: Song; myPart: PartId }) {
  const available = partsOf(song.training);
  const initial = available.includes(myPart) ? myPart : available[0];
  const [part, setPart] = useState<PartId>(initial);

  const file = song.training[part];

  return (
    <div className="playerpage">
      <button className="back" onClick={() => navigate({ name: "song", id: song.id })}>
        ← {song.title}
      </button>
      <div className="playerpage-head">
        <h1 className="song-heading">{song.title}</h1>
        <span className="mode-tag mode-learn">🎓 Training</span>
      </div>

      <div className="part-tabs">
        {available.map((p) => (
          <button
            key={p}
            className={`part-tab ${p === part ? "part-tab-on" : ""}`}
            onClick={() => setPart(p)}
            aria-pressed={p === part}
          >
            {PART_LABELS[p]}
            {p === myPart && <span className="you-dot" title="Your part" />}
          </button>
        ))}
      </div>

      {file ? (
        <SimpleAudioPlayer key={file.path} src={resolveUrl(file.path)} />
      ) : (
        <p className="muted">This part isn’t available for training.</p>
      )}
    </div>
  );
}
