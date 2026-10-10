import { useState } from "react";
import { type ExtraTrack, PART_LABELS, type PartId, type Song } from "../types";
import { navigate } from "../hooks/useHashRoute";
import { BackButton } from "./BackButton";
import { hasExtras, partsOf, resolveUrl } from "../lib/songs";
import { SimpleAudioPlayer } from "./SimpleAudioPlayer";

function ExtraItem({ extra, myPart }: { extra: ExtraTrack; myPart: PartId }) {
  const available = extra.parts ? partsOf(extra.parts) : [];
  const [part, setPart] = useState<PartId | undefined>(
    available.includes(myPart) ? myPart : available[0],
  );
  const partFile = part ? extra.parts?.[part] : undefined;

  return (
    <section className="extra">
      <h2 className="extra-title">{extra.title}</h2>
      {extra.all && <SimpleAudioPlayer src={resolveUrl(extra.all.path)} />}
      {available.length > 0 && (
        <>
          <p className="muted extra-note">
            Greg recorded one of these for each part.
          </p>
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
          {partFile && (
            <SimpleAudioPlayer
              key={partFile.path}
              src={resolveUrl(partFile.path)}
            />
          )}
        </>
      )}
    </section>
  );
}

export function SongExtras({ song, myPart }: { song: Song; myPart: PartId }) {
  return (
    <div className="playerpage">
      <BackButton
        fallback={{ name: "song", id: song.id }}
        fallbackLabel={song.title}
      />
      <div className="playerpage-head">
        <h1 className="song-heading">{song.title}</h1>
        <span className="mode-tag mode-bits">🧩 Bits &amp; Bobs</span>
      </div>
      <p className="muted">
        Extra parts and song structure.{" "}
        <button className="link" onClick={() => navigate({ name: "bits" })}>
          What are Bits &amp; Bobs?
        </button>
      </p>
      {(song.extras || []).map((extra) => (
        <ExtraItem key={extra.id} extra={extra} myPart={myPart} />
      ))}
    </div>
  );
}

export function BitsAndBobsHome({
  songs,
  general,
  myPart,
}: {
  songs: Song[];
  general: ExtraTrack[];
  myPart: PartId;
}) {
  const entries = uniqueExtras(songs);

  return (
    <div className="playerpage">
      <BackButton fallback={{ name: "home" }} fallbackLabel="All songs" />
      <div className="playerpage-head">
        <h1 className="song-heading">Bits &amp; Bobs</h1>
        <span className="mode-tag mode-bits">🧩 Extras</span>
      </div>
      <p className="muted">
        The extra parts the choir sings on top of what you’ve already learned,
        plus any changes to the song structure. Please listen to all of them.
      </p>
      {general.map((extra) => (
        <ExtraItem key={extra.id} extra={extra} myPart={myPart} />
      ))}
      <ul className="cards bits-songs">
        {entries.map(({ song, title }) => (
          <li key={song.id}>
            <button
              className="card"
              onClick={() => navigate({ name: "extras", id: song.id })}
            >
              <span className="card-title">{title}</span>
              <span className="card-badges">
                {song.extras!.map((extra) => (
                  <span key={extra.id} className="badge badge-bits">
                    {extra.title}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Songs split into sections (e.g. "The Chain (Chorus)", "The Chain (Outro)")
// share the same extras, so list each set of extras once, under the song's
// base title.
function uniqueExtras(songs: Song[]): { song: Song; title: string }[] {
  const groups = new Map<string, Song[]>();
  for (const song of [...songs].filter(hasExtras).sort((a, b) =>
    a.title.localeCompare(b.title),
  )) {
    const key = song.extras!.map((e) => e.id).sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), song]);
  }
  return [...groups.values()]
    .map((group) => ({
      song: group[0],
      title:
        group.length > 1
          ? group[0].title.replace(/\s*\([^)]*\)\s*$/, "")
          : group[0].title,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
