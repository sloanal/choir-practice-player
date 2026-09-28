import test from "node:test";
import assert from "node:assert/strict";
import { groupSongs } from "./grouping.mjs";

function entry(path, name = path.split("/").at(-1)) {
  return { path, name, size: 1 };
}

test("keeps a base song and its parenthetical section separate", () => {
  const { songs, warnings } = groupSongs([
    entry("/Highers/Singing Only/Lay Down - Singing - Highers.m4a"),
    entry("/Highers/Singing Only/Lay Down (BRIDGE) - Singing - Highers.m4a"),
  ]);

  assert.deepEqual(songs.map((song) => song.id), ["lay-down", "lay-down-bridge"]);
  assert.deepEqual(warnings, []);
});

test("explicit aliases still merge known filename variants", () => {
  const { songs } = groupSongs(
    [
      entry("/Highers/Singing Only/You belong w me Ch1 - Singing - Highers.m4a"),
      entry("/Lowers/LEARN/You belong with me - LEARN - Lowers.m4a"),
    ],
    { "you belong with me ch1": "you belong with me" }
  );

  assert.equal(songs.length, 1);
  assert.equal(songs[0].id, "you-belong-with-me");
  assert.ok(songs[0].singing.high);
  assert.ok(songs[0].training.low);
});
