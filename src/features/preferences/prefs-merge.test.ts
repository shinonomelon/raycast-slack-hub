import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPrefs, parsePrefs } from "./prefs-merge.ts";

test("形が違う項目は、エラーにせず無いものとして扱う", () => {
  const broken = {
    favorites: "C1",
    aliases: ["not", "a", "record"],
    dictionary: [{ from: 1, to: "x" }, { from: "", to: "y" }, "oops", null],
    membership: "nobody",
  };
  assert.deepEqual(parsePrefs(broken), emptyPrefs());
  assert.deepEqual(parsePrefs(null), emptyPrefs());
  assert.deepEqual(parsePrefs("text"), emptyPrefs());
  assert.deepEqual(parsePrefs([]), emptyPrefs());
});

test("読み込みでは、使える項目だけを残し、お気に入りの重複を除く", () => {
  const parsed = parsePrefs({
    favorites: ["C1", "C2", "C1", 3, ""],
    aliases: { C1: ["a", 5, ""], C2: [], C3: "x" },
    dictionary: [{ from: "x", to: "" }, { from: "y" }],
    membership: "notJoined",
  });
  assert.deepEqual(parsed, {
    favorites: ["C1", "C2"],
    aliases: { C1: ["a"] },
    dictionary: [{ from: "x", to: "" }],
    membership: "notJoined",
  });
});

test("空の設定は呼ぶたびに別の値になる（書き換えが残らない）", () => {
  const first = emptyPrefs();
  first.favorites.push("C1");
  first.aliases.C1 = ["a"];
  assert.deepEqual(emptyPrefs(), {
    favorites: [],
    aliases: {},
    dictionary: [],
    membership: "all",
  });
});
