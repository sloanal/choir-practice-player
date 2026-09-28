import { createHash } from "node:crypto";

export function recipeFingerprint(version, recipe, part) {
  return createHash("sha256").update(JSON.stringify({
    version, duration: recipe.duration, referencePart: recipe.referencePart, correction: recipe.parts[part],
  })).digest("hex");
}

export function validateRecipe(recipe) {
  const fail = message => { throw new Error(`Invalid alignment map: ${message}`); };
  if (!Number.isFinite(recipe.duration) || recipe.duration <= 0) fail("duration");
  if (!["high", "mid", "low"].includes(recipe.referencePart)) fail("reference part");
  let timeline;
  for (const part of ["high", "mid", "low"]) {
    const correction = recipe.parts?.[part];
    if (!correction?.sections?.length) fail(`missing ${part} sections`);
    if (!/^[a-f0-9]{64}$/.test(correction.sourceSha256 || "")) fail(`${part} source hash`);
    let end = 0;
    const spans = [];
    for (const section of correction.sections) {
      const a = section.anchors;
      if (!Number.isFinite(section.outputStart) || section.outputStart < end) fail(`${part} section overlap`);
      if (!Array.isArray(a) || a.length < 2 || a[0][0] !== 0) fail(`${part} anchors`);
      for (let i = 0; i < a.length; i++) {
        if (a[i].length !== 2 || a[i].some(x => !Number.isFinite(x) || x < 0)) fail(`${part} invalid anchor`);
        if (i && (a[i][0] <= a[i-1][0] || a[i][1] <= a[i-1][1])) fail(`${part} non-monotonic anchor`);
      }
      end = section.outputStart + a.at(-1)[0];
      if (end > recipe.duration + 0.0001) fail(`${part} beyond duration`);
      spans.push([section.outputStart, a.at(-1)[0]]);
    }
    const serialized = JSON.stringify(spans);
    if (timeline && serialized !== timeline) fail("parts must share section boundaries");
    timeline = serialized;
    for (const range of correction.muteSourceRanges || []) {
      if (range.length !== 2 || range.some(x => !Number.isFinite(x) || x < 0) || range[1] <= range[0]) fail("invalid mute range");
    }
  }
}
