import test from "node:test";
import assert from "node:assert/strict";
import { groupExtras, groupSongs } from "./grouping.mjs";

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

test("groups part files that have no singing/learn marker", () => {
  const { songs, warnings } = groupSongs([
    entry("/Highers/Singing Only/You belong, Bridge to End - Highers.m4a"),
    entry("/Lowers/Singing Only/You belong Bridge to End - Lowers.m4a"),
    entry("/Mids/Singing only/You belong Bridge to End - Mids.m4a"),
  ]);

  assert.deepEqual(warnings, []);
  assert.equal(songs.length, 1);
  assert.deepEqual(Object.keys(songs[0].singing).sort(), ["high", "low", "mid"]);
});

test("attaches Bits & Bobs to every matching song section", () => {
  const all = [
    entry("/Highers/Singing Only/The chain (CHORUS) - Singing - Highers.m4a"),
    entry("/Highers/Singing Only/The chain (outro) - Singing - Highers.m4a"),
    entry("/Highers/LEARN/You belong with me - LEARN - Highers.m4a"),
    entry("/Highers/Singing Only/You belong, Bridge to End - Highers.m4a"),
    entry("/Bits&Bobs & Structure/The Chain B&B - structure.m4a"),
    entry("/Bits&Bobs & Structure/Diamonds B&B + structure + ending.m4a"),
    entry("/Bits&Bobs & Structure/You belong B&B - Highers.m4a"),
    entry("/Bits&Bobs & Structure/Bits & Bobs explanation!.m4a"),
  ];
  const { songs, warnings } = groupSongs(all);
  assert.deepEqual(warnings, []);
  assert.equal(songs.length, 4);

  const { general } = groupExtras(all, songs);
  const byId = Object.fromEntries(songs.map((song) => [song.id, song]));

  assert.deepEqual(general.map((extra) => extra.title), ["Bits & Bobs explanation", "Diamonds B&B + structure + ending"]);
  assert.equal(byId["the-chain-chorus"].extras[0].title, "Structure");
  assert.equal(byId["the-chain-outro"].extras[0].all.name, "The Chain B&B - structure.m4a");

  const bridge = byId["you-belong-bridge-to-end"];
  assert.equal(bridge.extras[0].title, "Bits & Bobs");
  assert.ok(bridge.extras[0].parts.high);
  assert.equal(bridge.training.high, bridge.extras[0].parts.high);
  assert.equal(byId["you-belong-with-me"].training.high.name, "You belong with me - LEARN - Highers.m4a");
});
