import type { TrackInput } from "../audio/engine";
import { PART_ORDER, type PartId, type PartMap, type Song } from "../types";

export function partsOf(map: PartMap): PartId[] {
  return PART_ORDER.filter((p) => map[p]);
}

export function hasTraining(song: Song): boolean {
  return partsOf(song.training).length > 0;
}

export function hasSinging(song: Song): boolean {
  return partsOf(song.singing).length > 0;
}

export function resolveUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export function singingInputs(song: Song): TrackInput[] {
  return partsOf(song.singing).map((p) => {
    const file = song.singing[p]!;
    return {
      id: p,
      url: resolveUrl(file.path),
      // Prepared tracks already share an exact zero point. Running onset
      // detection again would undo that alignment when one part rests.
      onset: file.alignment ? 0 : undefined,
    };
  });
}

export function findSong(songs: Song[], id: string): Song | undefined {
  return songs.find((s) => s.id === id);
}
