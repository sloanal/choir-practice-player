// Shared logic for turning Dropbox filenames into grouped songs.
// Kept dependency-free so it can be unit-checked in isolation.

export const AUDIO_EXTS = [".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac"];

export function isAudio(name) {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

/** Detect voice part from the full Dropbox path. */
export function detectPart(path) {
  const p = path.toLowerCase();
  if (/\bhigh(er)?s?\b/.test(p)) return "high";
  if (/\blow(er)?s?\b/.test(p)) return "low";
  if (/\bmid(s)?\b/.test(p)) return "mid";
  return null;
}

/** Detect training vs singing from the full Dropbox path. */
export function detectType(path) {
  const p = path.toLowerCase();
  if (/\blearn\b/.test(p)) return "training";
  if (/\bsing/.test(p)) return "singing";
  return null;
}

/** Pull a human song title out of a filename. */
export function titleFromFilename(name) {
  let base = name.replace(/\.[^.]+$/, ""); // strip extension
  // Cut everything from the type marker onward ("... Singing - Mids").
  const marker = base.search(/\b(singing|learn)\b/i);
  if (marker > 0) base = base.slice(0, marker);
  // Trim trailing separators/dashes/spaces.
  base = base.replace(/[\s\u2013\u2014\-–—_]+$/g, "").trim();
  return base;
}

/** Normalize a title for matching (lowercase, expand abbreviations, strip punctuation). */
export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\bw\/?\b/g, "with")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9()\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(normalized) {
  return normalized
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function tokens(normalized) {
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function qualifiers(normalized) {
  return [...normalized.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]).join("|");
}

/**
 * Group entries (each { path, name, size, contentHash, modified }) into songs.
 * Returns { songs, warnings }.
 *
 * aliases: optional map of normalizedTitle -> canonicalNormalizedTitle.
 */
export function groupSongs(entries, aliases = {}) {
  const songs = [];
  const warnings = [];

  const findSong = (norm) => {
    // Exact / alias match first.
    const canonical = aliases[norm] || norm;
    let hit = songs.find((s) => s.norm === canonical || s.norm === norm);
    if (hit) return hit;
    // Fuzzy: high token overlap + prefix relationship handles
    // variants like "you belong w me ch1" vs "you belong with me".
    const t = tokens(canonical);
    for (const s of songs) {
      // Parenthetical labels identify distinct arranged sections (for example,
      // "Lay Down" and "Lay Down (Bridge)") and must never fuzzy-collapse.
      if (qualifiers(canonical) !== qualifiers(s.norm)) continue;
      const st = tokens(s.norm);
      const score = jaccard(t, st);
      const shorter = canonical.length <= s.norm.length ? canonical : s.norm;
      const longer = canonical.length <= s.norm.length ? s.norm : canonical;
      if (score >= 0.6 && longer.startsWith(shorter)) return s;
    }
    return null;
  };

  for (const entry of entries) {
    if (!isAudio(entry.name)) continue;
    const part = detectPart(entry.path);
    const type = detectType(entry.path);
    if (!part || !type) {
      warnings.push(`Skipped (couldn't classify part/type): ${entry.path}`);
      continue;
    }
    const title = titleFromFilename(entry.name);
    const norm = normalizeTitle(title);
    if (!norm) {
      warnings.push(`Skipped (empty title): ${entry.path}`);
      continue;
    }

    let song = findSong(norm);
    if (!song) {
      song = {
        norm,
        title,
        singing: {},
        training: {},
        _titles: { singing: null, training: null },
      };
      songs.push(song);
    }

    const file = {
      name: entry.name,
      size: entry.size,
      contentHash: entry.contentHash,
      modified: entry.modified,
      sourcePath: entry.path,
    };

    if (song[type][part]) {
      warnings.push(
        `Duplicate ${type}/${part} for "${song.title}": ${entry.path} (keeping first)`
      );
      continue;
    }
    song[type][part] = file;
    // Prefer the "singing" spelling of the title for display.
    if (type === "singing") song.title = title;
    else if (!song._titles.singing && !hasAny(song.singing)) song.title = title;
  }

  const finalSongs = songs.map((s) => ({
    id: slugify(aliases[s.norm] || s.norm),
    title: s.title,
    singing: stripSource(s.singing),
    training: stripSource(s.training),
  }));

  finalSongs.sort((a, b) => a.title.localeCompare(b.title));
  return { songs: finalSongs, groups: songs, warnings };
}

function hasAny(map) {
  return Object.keys(map).length > 0;
}

function stripSource(map) {
  const out = {};
  for (const [part, file] of Object.entries(map)) {
    out[part] = { ...file };
  }
  return out;
}
