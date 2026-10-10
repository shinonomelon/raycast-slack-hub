import test from "node:test";
import assert from "node:assert/strict";
import { hubFavorites, searchScopeTitle } from "./hub-scope.ts";
const library = {
  version: 1 as const,
  teamId: "T1",
  userId: "U1",
  favoriteChannelIds: ["C2"],
  sections: [{ id: "s", name: "開発", channelIds: ["C1"] }],
};
const conversations = [
  { id: "C1", name: "one", type: "public" as const },
  { id: "C2", name: "two", type: "private" as const },
  { id: "C3", name: "group", type: "mpim" as const },
];
test("移行前のチャンネル印を別アカウントへ表示せず、人物とグループDMは残す", () => {
  assert.deepEqual(
    hubFavorites(["C1", "C3", "U2"], library, false, conversations),
    ["C3", "U2"],
  );
  assert.deepEqual(
    hubFavorites(["C1", "C3", "U2"], library, true, conversations),
    ["C3", "U2", "C2"],
  );
});
test("削除済みセクションはすべてという表示へ戻らない", () => {
  assert.equal(
    searchScopeTitle(
      { range: { kind: "section", sectionId: "missing" } },
      library,
      conversations,
      [],
    ),
    "削除されたセクション",
  );
});
