import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyPrefs,
  mergeLegacy,
  parsePrefs,
  resolveInitialPrefs,
  type LegacyReaders,
} from "./prefs-merge.ts";

// Open Channel の prefs.json と同じ形（試験用のお気に入り1・別名0・辞書2）。
// 別名は、引き継ぎで残ることを確かめるために1件入れている
const OPEN_CHANNEL_PREFS = {
  favorites: ["C0000000006"],
  aliases: { C0000000003: ["分報"] },
  dictionary: [
    { from: "自動取得", to: "auto" },
    { from: "オペレーター", to: "ope" },
  ],
  membership: "joined",
};

// Quick Compose の entries.json と同じ形（試験用のメンション相手2・チャンネル4）。
// 登録チャンネルの1つ目は、Open Channel のお気に入りと同じもの
const QUICK_COMPOSE_ENTRIES = {
  targets: [
    { id: "U0000000013", name: "自分（田中）" },
    { id: "U0000000015", name: "ExampleBot" },
  ],
  channels: [
    { id: "C0000000006", name: "#example_asobiba" },
    { id: "C0000000003", name: "#times_example_user" },
    { id: "C0000000004", name: "#example_remind" },
    { id: "C0000000005", name: "#学習チャンネル" },
  ],
};

test("お気に入りは重複なく4件になり、辞書・別名・絞り込みが残る", () => {
  const merged = mergeLegacy(OPEN_CHANNEL_PREFS, QUICK_COMPOSE_ENTRIES);
  assert.deepEqual(merged.favorites, [
    "C0000000006",
    "C0000000003",
    "C0000000004",
    "C0000000005",
  ]);
  assert.deepEqual(merged.aliases, { C0000000003: ["分報"] });
  assert.deepEqual(merged.dictionary, [
    { from: "自動取得", to: "auto" },
    { from: "オペレーター", to: "ope" },
  ]);
  assert.equal(merged.membership, "joined");
});

test("Quick Compose に登録したメンション相手は引き継がない", () => {
  const merged = mergeLegacy(OPEN_CHANNEL_PREFS, QUICK_COMPOSE_ENTRIES);
  assert.ok(!merged.favorites.some((id) => id.startsWith("U")));
});

test("引き継ぎ元のどちらかが無い・壊れているときは、その分だけ引き継がない", () => {
  // Quick Compose が無い：Open Channel の分だけ
  assert.deepEqual(mergeLegacy(OPEN_CHANNEL_PREFS, undefined).favorites, [
    "C0000000006",
  ]);
  // Open Channel が無い：登録チャンネルだけがお気に入りになる。絞り込みは既定の「すべて」
  const onlyCompose = mergeLegacy(undefined, QUICK_COMPOSE_ENTRIES);
  assert.equal(onlyCompose.favorites.length, 4);
  assert.deepEqual(onlyCompose.dictionary, []);
  assert.equal(onlyCompose.membership, "all");
  // 両方無い：空の設定。Quick Compose の初期値（登録が無いときの選択肢）は足さない
  assert.deepEqual(mergeLegacy(undefined, undefined), emptyPrefs());
});

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
  // channels が配列でない・要素が壊れている
  assert.deepEqual(mergeLegacy({}, { channels: "C1" }).favorites, []);
  assert.deepEqual(
    mergeLegacy({}, { channels: [null, { id: 1 }, { id: "" }, { id: "C9" }] })
      .favorites,
    ["C9"],
  );
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

// ---- 初期の設定の決め方 ------------------------------------------------------------

// 呼ばれた回数を数える引き継ぎ元の読み出し
function spyReaders(
  openChannel: unknown = OPEN_CHANNEL_PREFS,
  quickCompose: unknown = QUICK_COMPOSE_ENTRIES,
) {
  const calls = { openChannel: 0, quickCompose: 0 };
  const readers: LegacyReaders = {
    openChannel: () => {
      calls.openChannel += 1;
      return openChannel;
    },
    quickCompose: () => {
      calls.quickCompose += 1;
      return quickCompose;
    },
  };
  return { calls, readers };
}

test("Hub の prefs.json があるときは、それだけを使い、引き継ぎ元を読まない", () => {
  const { calls, readers } = spyReaders();
  const hub = {
    favorites: ["C-hub"],
    aliases: {},
    dictionary: [],
    membership: "notJoined",
  };
  const { prefs, inherited } = resolveInitialPrefs(hub, readers);
  assert.deepEqual(prefs, hub);
  assert.equal(inherited, false);
  assert.deepEqual(calls, { openChannel: 0, quickCompose: 0 });
});

test("Hub の prefs.json が空でも、あるものとして扱い、引き継ぎ元を読まない", () => {
  const { calls, readers } = spyReaders();
  const { prefs, inherited } = resolveInitialPrefs({}, readers);
  assert.deepEqual(prefs, emptyPrefs());
  assert.equal(inherited, false);
  assert.deepEqual(calls, { openChannel: 0, quickCompose: 0 });
});

test("Hub の prefs.json が無い初回だけ、引き継ぎ元を1回ずつ読んで合成する", () => {
  const { calls, readers } = spyReaders();
  const { prefs, inherited } = resolveInitialPrefs(undefined, readers);
  assert.equal(inherited, true);
  assert.equal(prefs.favorites.length, 4);
  assert.equal(prefs.dictionary.length, 2);
  assert.deepEqual(calls, { openChannel: 1, quickCompose: 1 });
});

test("引き継ぎ元の読み出しが投げても、エラーにせず、読めなかった分を引き継がない", () => {
  const readers: LegacyReaders = {
    openChannel: () => {
      throw new Error("読めない");
    },
    quickCompose: () => QUICK_COMPOSE_ENTRIES,
  };
  const { prefs, inherited } = resolveInitialPrefs(undefined, readers);
  assert.equal(inherited, true);
  assert.equal(prefs.favorites.length, 4);
  assert.deepEqual(prefs.dictionary, []);
});

test("引き継ぎ元が両方とも無いときは、空の設定で始める", () => {
  const none: LegacyReaders = {
    openChannel: () => undefined,
    quickCompose: () => undefined,
  };
  const { prefs, inherited } = resolveInitialPrefs(undefined, none);
  assert.deepEqual(prefs, emptyPrefs());
  assert.equal(inherited, true);
});
