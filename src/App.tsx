import { type ReactNode, useEffect } from "react";
import { useManifest } from "./hooks/useManifest";
import { navigate, useHashRoute } from "./hooks/useHashRoute";
import { useMyPart } from "./hooks/useMyPart";
import { useOnline } from "./hooks/useOnline";
import { syncWithManifest } from "./offline/offlineStore";
import { findSong } from "./lib/songs";
import { PART_LABELS, PART_ORDER, type PartId } from "./types";
import { SongList } from "./components/SongList";
import { SongChooser } from "./components/SongChooser";
import { TrainingPlayer } from "./components/TrainingPlayer";
import { SingingPlayer } from "./components/SingingPlayer";
import { BitsAndBobsHome, SongExtras } from "./components/BitsAndBobs";

export function App() {
  const state = useManifest();
  const route = useHashRoute();
  const [myPart, setMyPart] = useMyPart();
  const online = useOnline();

  useEffect(() => {
    if (state.status === "ready") void syncWithManifest(state.manifest);
  }, [state]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => navigate({ name: "home" })}>
          <span className="brand-mark">♪</span>
          <span>Choir Practice</span>
        </button>
        {!online && <span className="offline-pill">Offline</span>}
        <label className="mypart">
          My part
          <select
            value={myPart}
            onChange={(e) => setMyPart(e.target.value as PartId)}
          >
            {PART_ORDER.map((p) => (
              <option key={p} value={p}>
                {PART_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className="main">
        {state.status === "loading" && <Centered>Loading songs…</Centered>}

        {state.status === "empty" && (
          <Centered>
            <h2>No songs yet</h2>
            <p className="muted">
              Run <code>npm run sync</code> (with a Dropbox token) or{" "}
              <code>npm run sample</code> for local demo audio, then reload.
            </p>
          </Centered>
        )}

        {state.status === "error" && (
          <Centered>
            <h2>Couldn’t load songs</h2>
            <p className="muted">{state.message}</p>
            <p className="muted">
              No <code>manifest.json</code> found. Run{" "}
              <code>npm run sample</code>{" "}
              for demo audio, or set up the Dropbox sync (see the README).
            </p>
          </Centered>
        )}

        {state.status === "ready" &&
          (() => {
            const songs = state.manifest.songs;
            const general = state.manifest.extras ?? [];
            if (route.name === "home") {
              return <SongList songs={songs} general={general} myPart={myPart} />;
            }
            if (route.name === "bits") {
              return (
                <BitsAndBobsHome
                  songs={songs}
                  general={general}
                  myPart={myPart}
                />
              );
            }
            const song = findSong(songs, route.id);
            if (!song) {
              return (
                <Centered>
                  <h2>Song not found</h2>
                  <button
                    className="btn"
                    onClick={() => navigate({ name: "home" })}
                  >
                    Back to songs
                  </button>
                </Centered>
              );
            }
            if (route.name === "song") return <SongChooser song={song} />;
            if (route.name === "training") {
              return <TrainingPlayer song={song} myPart={myPart} />;
            }
            if (route.name === "extras") {
              return <SongExtras song={song} myPart={myPart} />;
            }
            return <SingingPlayer song={song} myPart={myPart} />;
          })()}
      </main>

      <footer className="footer muted">
        {state.status === "ready" && (
          <span>
            {state.manifest.songs.length} songs · updated{" "}
            {new Date(state.manifest.generatedAt).toLocaleDateString()}
          </span>
        )}
      </footer>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="centered">{children}</div>;
}
