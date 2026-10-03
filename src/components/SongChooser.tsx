import type { Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { hasExtras, hasSinging, hasTraining, partsOf } from "../lib/songs";

export function SongChooser({ song }: { song: Song }) {
  const singing = hasSinging(song);
  const training = hasTraining(song);
  const extras = hasExtras(song);

  return (
    <div className="chooser">
      <button className="back" onClick={() => navigate({ name: "home" })}>
        ← All songs
      </button>
      <h1 className="song-heading">{song.title}</h1>
      <p className="muted">How do you want to practice?</p>

      <div className="choice-grid">
        <button
          className="choice choice-sing"
          disabled={!singing}
          onClick={() => navigate({ name: "singing", id: song.id })}
        >
          <span className="choice-icon">🎧</span>
          <span className="choice-title">Singing</span>
          <span className="choice-sub">
            {singing
              ? `Layer ${partsOf(song.singing).length} parts, isolate & loop`
              : "Not available"}
          </span>
        </button>

        <button
          className="choice choice-learn"
          disabled={!training}
          onClick={() => navigate({ name: "training", id: song.id })}
        >
          <span className="choice-icon">🎓</span>
          <span className="choice-title">Training</span>
          <span className="choice-sub">
            {training ? "Greg teaching your part" : "Not available"}
          </span>
        </button>

        {extras && (
          <button
            className="choice choice-bits"
            onClick={() => navigate({ name: "extras", id: song.id })}
          >
            <span className="choice-icon">🧩</span>
            <span className="choice-title">Bits &amp; Bobs</span>
            <span className="choice-sub">Extra parts &amp; song structure</span>
          </button>
        )}
      </div>
    </div>
  );
}
