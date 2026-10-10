import assert from "node:assert/strict";
import { test } from "node:test";
import { searchPage } from "../../slack/slack.ts";

test("searchPageは100件・指定page・残りtimeoutを渡しpagingの総ページを返す", async () => {
  let requested: unknown;
  const result = await searchPage("in:<#C1>", {
    selfId: "U1",
    page: 2,
    timeoutMs: 2500,
    api: async (_method, params, options) => {
      requested = { params, timeout: options?.timeoutMs };
      return {
        messages: { matches: [], total: 0, paging: { page: 2, pages: 3 } },
      };
    },
  });
  assert.deepEqual(requested, {
    params: {
      query: "in:<#C1>",
      sort: "timestamp",
      sort_dir: "desc",
      count: 100,
      page: 2,
      highlight: false,
    },
    timeout: 2500,
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.pageCount, 3);
    assert.equal(result.capped, true);
  }
});
