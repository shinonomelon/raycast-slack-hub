import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person, Prefs } from "../../shared/types.ts";
import { allMatches, memberRows, membershipStatus } from "./membership-view.ts";
const prefs: Prefs = {
  favorites: [],
  aliases: {},
  dictionary: [],
  membership: "all",
};
const person = (id: string, isBot = false): Person => ({
  id,
  displayName: `Person ${id}`,
  handle: `handle-${id}`,
  realName: `Real ${id}`,
  title: "",
  isBot,
});
test("APIの参加者IDを未知とボットを含めて保持し、通常の人だけ操作可能にする", () => {
  const rows = memberRows(
    ["U1", "U2", "U3"],
    [person("U1"), person("U2", true)],
    prefs,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["U1", "U2", "U3"],
  );
  assert.deepEqual(
    rows.map((row) => row.actionable),
    [true, false, false],
  );
  assert.equal(rows[1].subtitle, "ボット");
  assert.equal(rows[2].subtitle, "状態未確認");
  assert.equal(allMatches(rows, "U3")[0].id, "U3");
});
test("101人以上でも全体を表示し、末尾の人を別名とファジー検索で探せる", () => {
  const people = Array.from({ length: 150 }, (_, index) => person(`U${index}`));
  const rows = memberRows(
    people.map((person) => person.id),
    people,
    { ...prefs, aliases: { U149: ["project_alpha"] } },
  );
  assert.equal(allMatches(rows, "").length, 150);
  assert.equal(allMatches(rows, "project_alpa")[0].id, "U149");
});
test("前回結果、失敗、429を0件成功の表示と混同しない", () => {
  assert.match(
    membershipStatus({ status: "failed", data: [], error: "失敗" }),
    /失敗/,
  );
  assert.match(
    membershipStatus({
      status: "rate-limited",
      data: [],
      error: "制限",
      retryAfter: 30,
    }),
    /30秒/,
  );
  assert.match(
    membershipStatus({
      status: "loading",
      data: ["U1"],
      previous: true,
      fetchedAt: 1,
    }),
    /前回取得.*更新中.*取得/,
  );
  assert.match(
    membershipStatus({ status: "empty", data: [], fetchedAt: 1 }),
    /0件.*取得/,
  );
});
