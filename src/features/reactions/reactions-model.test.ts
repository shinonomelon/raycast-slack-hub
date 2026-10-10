import assert from "node:assert/strict";
import { test } from "node:test";
import {
  myReactionNames,
  readMessageReactions,
  STANDARD_REACTIONS,
  validReactionName,
} from "./reactions-model.ts";

const ts = "1791600000.000001";
const response = (reactions: unknown[]) => ({
  ok: true,
  type: "message",
  channel: "C1",
  message: { ts, reactions },
});
test("他人の反応を候補にせず、標準外の本人の反応も外せる", () => {
  const reactions = readMessageReactions(
    response([
      { name: "eyes", users: ["U2"], count: 4 },
      { name: "custom_emoji", users: ["U1", "U2"], count: 5 },
      { name: "thumbsup::skin-tone-3", users: ["U1"], count: 1 },
    ]),
    "C1",
    ts,
    "U1",
  );
  assert.deepEqual(myReactionNames(reactions), [
    "custom_emoji",
    "thumbsup::skin-tone-3",
  ]);
  assert.equal(reactions[0].count, 4);
  assert.equal(STANDARD_REACTIONS.length, 6);
});
test("別対象の応答・壊れたusers/countを拒否する", () => {
  for (const data of [
    { ...response([]), channel: "C2" },
    { ...response([]), type: "file" },
    response([{ name: "eyes", users: "U1", count: 1 }]),
    response([{ name: "eyes", users: [3], count: 1 }]),
    response([{ name: "eyes", users: ["U1"], count: -1 }]),
  ])
    assert.throws(() => readMessageReactions(data, "C1", ts, "U1"));
  assert.deepEqual(
    readMessageReactions(
      { ok: true, type: "message", channel: "C1", message: { ts } },
      "C1",
      ts,
      "U1",
    ),
    [],
  );
});
test("名前はSlackのemoji nameのみ。表示文字列やURLを送らない", () => {
  assert.equal(validReactionName("+1"), true);
  assert.equal(validReactionName("thumbsup::skin-tone-3"), true);
  for (const name of [
    "✅",
    ":eyes:",
    "https://example.com",
    "確認しました",
    "eyes\n",
  ])
    assert.equal(validReactionName(name), false);
});
