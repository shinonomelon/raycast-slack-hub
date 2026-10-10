import test from "node:test";
import assert from "node:assert/strict";
import type { Hit } from "../../slack/hits.ts";
import type { ApiCall } from "../../slack/slack-api.ts";
import {
  messageTaskSource,
  sourceMatchesHit,
  taskTitleFromMessage,
} from "./message-task.ts";
const url = "https://test.slack.com/archives/CTEST/p1790967145033309";
const hit: Hit = {
  key: "CTEST:1790967145.033309",
  channelId: "CTEST",
  ts: "1790967145.033309",
  text: "依頼\nお願いします",
  permalink: url,
  channelKind: "channel",
  mentionsSelf: false,
};
test("編集用タイトル案は検索プレビューの120字まで", () => {
  assert.equal(taskTitleFromMessage(hit), "依頼 お願いします");
  assert.equal(taskTitleFromMessage({ text: "x".repeat(300) }).length, 120);
});
test("valid permalinkは追加API0回、異なる投稿URLは取得し直す", async () => {
  let calls = 0;
  const api: ApiCall = async (method, params) => {
    calls++;
    assert.equal(method, "chat.getPermalink");
    assert.deepEqual(params, { channel: hit.channelId, message_ts: hit.ts });
    return { ok: true, permalink: url };
  };
  assert.equal(await messageTaskSource(api, hit), url);
  assert.equal(calls, 0);
  assert.equal(
    await messageTaskSource(api, {
      ...hit,
      permalink: "https://test.slack.com/archives/COTHER/p1790967145033309",
    }),
    url,
  );
  assert.equal(calls, 1);
});
test("Slack以外・異なるts・不明URLは出典付き作成を停止", async () => {
  assert.equal(
    sourceMatchesHit("https://evil.com/archives/CTEST/p1790967145033309", hit),
    false,
  );
  assert.equal(
    sourceMatchesHit(
      "https://test.slack.com/archives/CTEST/p1790967145033310",
      hit,
    ),
    false,
  );
  const api: ApiCall = async () => ({
    ok: true,
    permalink: "https://evil.com/a",
  });
  await assert.rejects(messageTaskSource(api, { ...hit, permalink: "" }));
});
