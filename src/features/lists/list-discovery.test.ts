import test from "node:test";
import assert from "node:assert/strict";
import type { ApiCall } from "../../slack/slack-api.ts";
import { discoverLists, listIdFromInput, rankLists } from "./list-discovery.ts";
test("リスト発見はlegacy検索のページ番号で送りLists以外を除外", async () => {
  const calls: unknown[] = [];
  const api: ApiCall = async (method, params) => {
    calls.push([method, params]);
    return {
      ok: true,
      files: {
        matches: [
          { id: "FA", filetype: "list", title: "One" },
          { id: "FB", mimetype: "application/vnd.slack-list", title: "Two" },
          { id: "FC", filetype: "pdf" },
        ],
        paging: { total: 250, pages: 3 },
      },
    };
  };
  const page = await discoverLists(api, "TTEST", 2);
  assert.deepEqual(calls, [
    ["search.files", { query: "type:list", count: 100, page: 2 }],
  ]);
  assert.deepEqual(
    page.lists.map((list) => list.id),
    ["FA", "FB"],
  );
  assert.equal(page.hasMore, true);
});
test("100ページ超過は通信0回、上限時は網羅取得を主張しない", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return {
      ok: true,
      files: { matches: [], paging: { total: 15000, pages: 150 } },
    };
  };
  await assert.rejects(discoverLists(api, "TTEST", 101));
  assert.equal(calls, 0);
  const page = await discoverLists(api, "TTEST", 100);
  assert.equal(page.capped, true);
  assert.equal(page.hasMore, false);
});
test("名前検索は既存fuzzy規則で取得済み項目だけを照合", () => {
  assert.equal(
    rankLists(
      [
        { id: "FA", title: "project", url: "x" },
        { id: "FB", title: "other", url: "x" },
      ],
      "projet",
    )[0]?.id,
    "FA",
  );
});
test("URLとIDはteam/list IDを一致確認して抽出", () => {
  assert.equal(listIdFromInput("FTEST", "TTEST"), "FTEST");
  assert.equal(
    listIdFromInput("https://app.slack.com/lists/TTEST/FTEST", "TTEST"),
    "FTEST",
  );
  assert.equal(
    listIdFromInput(
      "https://test.slack.com/lists/TTEST/FTEST?team_id=TTEST&list_id=FTEST",
      "TTEST",
    ),
    "FTEST",
  );
});
for (const input of [
  "https://evil.com/lists/TTEST/FTEST",
  "https://slack.com.evil.com/lists/TTEST/FTEST",
  "https://evil@team.slack.com/lists/TTEST/FTEST",
  "file:///lists/TTEST/FTEST",
  "https://app.slack.com:444/lists/TTEST/FTEST",
  "https://app.slack.com/lists/TOTHER/FTEST",
  "https://test.slack.com/lists/TTEST/FTEST?team_id=TOTHER",
  "https://test.slack.com/lists/TTEST/FTEST?list_id=FOTHER",
  "https://app.slack.com/archives/CTEST/xxx",
  "FTEST/../../etc",
]) {
  test(`任意通信に使えないURLを拒否: ${input}`, () =>
    assert.throws(() => listIdFromInput(input, "TTEST")));
}

test("Slackワークスペースのredirリストリンクも固定APIのIDだけ取り出す", () => {
  assert.equal(
    listIdFromInput(
      "https://test.slack.com/?redir=%2Flists%2FTTEST%2FFTEST%3Fteam_id%3DTTEST%26list_id%3DFTEST",
      "TTEST",
    ),
    "FTEST",
  );
  assert.throws(() =>
    listIdFromInput(
      "https://test.slack.com/?redir=https%3A%2F%2Fevil.com%2Flists%2FTTEST%2FFTEST",
      "TTEST",
    ),
  );
  assert.throws(() =>
    listIdFromInput(
      "https://app.slack.com/lists/TTEST/FTEST?team_id=TTEST&team_id=TOTHER",
      "TTEST",
    ),
  );
});
