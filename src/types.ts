export type PartId = "high" | "mid" | "low";

export const PART_ORDER: PartId[] = ["high", "mid", "low"];

export const PART_LABELS: Record<PartId, string> = {
  high: "Highers",
  mid: "Mids",
  low: "Lowers",
};

export const PART_SHORT: Record<PartId, string> = {
  high: "High",
  mid: "Mid",
  low: "Low",
};

export interface TrackFile {
  /** Path relative to the site root, e.g. "audio/because-the-night/singing-mid.m4a". */
  path: string;
  /** Original Dropbox filename. */
  name: string;
  size: number;
  contentHash?: string;
  modified?: string;
  /** Cached unprocessed source used to regenerate an aligned singing track. */
  rawPath?: string;
  sourceSize?: number;
  /** Present when the source was tempo-corrected and placed on the song timeline. */
  alignment?: {
    version: number;
    sourceOffset?: number;
    tempo?: number;
    fingerprint?: string;
    method?: string;
    sections?: number;
    anchors?: number;
    duration: number;
    referencePart: PartId;
  };
}

export type PartMap = Partial<Record<PartId, TrackFile>>;

/** A "Bits & Bobs" recording: extra parts and structure notes from Greg. */
export interface ExtraTrack {
  id: string;
  title: string;
  /** One recording for every part… */
  all?: TrackFile;
  /** …or one per part. */
  parts?: PartMap;
}

export interface Song {
  id: string;
  title: string;
  /** One recording per part, layered together in the singing player. */
  singing: PartMap;
  /** Greg's teaching recordings, one per part, played individually. */
  training: PartMap;
  extras?: ExtraTrack[];
}

export interface Manifest {
  generatedAt: string;
  source: string;
  songs: Song[];
  /** Bits & Bobs recordings that aren't about a single song. */
  extras?: ExtraTrack[];
}
