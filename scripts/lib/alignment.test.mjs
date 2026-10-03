import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateRecipe, recipeFingerprint } from "./alignment.mjs";

const recipes = JSON.parse(fs.readFileSync(new URL("../audio-alignment.json", import.meta.url), "utf8"));
const good = () => structuredClone(recipes.songs["you-belong-with-me"]);
test("every reviewed song has three monotonic maps on the same timeline", () => {
  assert.equal(Object.keys(recipes.songs).length, 14);
  for (const recipe of Object.values(recipes.songs)) validateRecipe(recipe);
});
test("reject reversed source time, overlapping sections, and mismatched trios", () => {
  const reversed = good(); reversed.parts.mid.sections[0].anchors[1][1] = 0;
  assert.throws(() => validateRecipe(reversed), /non-monotonic/);
  const overlap = good(); overlap.parts.high.sections.push(overlap.parts.high.sections[0]);
  assert.throws(() => validateRecipe(overlap), /overlap/);
  const mismatch = good(); mismatch.parts.mid.sections[0].anchors.at(-1)[0] -= .1;
  assert.throws(() => validateRecipe(mismatch), /boundaries/);
});
test("changing source, timing, or renderer version invalidates cached audio", () => {
  const recipe = good(), before = recipeFingerprint(4, recipe, "mid");
  recipe.parts.mid.sections[0].anchors[1][1] += .001;
  assert.notEqual(recipeFingerprint(4, recipe, "mid"), before);
  assert.notEqual(recipeFingerprint(5, good(), "mid"), before);
  const changedSource = good(); changedSource.parts.mid.sourceSha256 = "a".repeat(64);
  assert.notEqual(recipeFingerprint(4, changedSource, "mid"), before);
});
