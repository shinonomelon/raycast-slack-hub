import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import { fetchReactions, writeReaction } from "./reactions-api.ts";

const hit: Hit = {
  key: "C1:1791600000.000001",
  channelId: "C1",
  ts: "1791600000.000001",
  text: "preview",
  permalink: "",
  mentionsSelf: false,
  channelKind: "channel",
};
test("channel/timestampで本人の反応を読み、追加/除去は指定の1メッセージのみ", async () => {
  const calls: unknown[] = [];
  const api: ApiCall = async (method, params) => {
    calls.push([method, params]);
    return method === "reactions.get"
      ? {
          ok: true,
          type: "message",
          channel: hit.channelId,
          message: {
            ts: hit.ts,
            reactions: [{ name: "eyes", users: ["U1"], count: 2 }],
          },
        }
      : { ok: true };
  };
  const reactions = await fetchReactions(api, hit, "U1");
  assert.equal(reactions[0].mine, true);
  assert.equal(
    (await writeReaction(api, hit, "eyes", "add")).kind,
    "succeeded",
  );
  assert.equal(
    (await writeReaction(api, hit, "eyes", "remove")).kind,
    "succeeded",
  );
  assert.deepEqual(calls, [
    ["reactions.get", { channel: "C1", timestamp: hit.ts, full: true }],
    ["reactions.add", { channel: "C1", timestamp: hit.ts, name: "eyes" }],
    ["reactions.remove", { channel: "C1", timestamp: hit.ts, name: "eyes" }],
  ]);
});
test("already_reacted/no_reactionは意図した状態。自動再送しない", async () => {
  for (const mode of ["add", "remove"] as const) {
    let calls = 0;
    const api: ApiCall = async () => {
      calls++;
      throw new SlackApiError(
        "api",
        "existing",
        undefined,
        mode === "add" ? "already_reacted" : "no_reaction",
      );
    };
    assert.equal(
      (await writeReaction(api, hit, "eyes", mode)).kind,
      "succeeded",
    );
    assert.equal(calls, 1);
  }
});
test("拒否と結果未確認を分け、未知の成功応答も成功扱いしない", async () => {
  for (const [error, kind] of [
    [new SlackApiError("api", "scope", undefined, "missing_scope"), "failed"],
    [new SlackApiError("timeout", "timeout"), "unconfirmed"],
    [
      new SlackApiError("api", "partial", undefined, "internal_error"),
      "unconfirmed",
    ],
    [new SlackApiError("rate_limited", "wait", 30), "failed"],
  ] as const) {
    let calls = 0;
    assert.equal(
      (
        await writeReaction(
          async () => {
            calls++;
            throw error;
          },
          hit,
          "eyes",
          "add",
        )
      ).kind,
      kind,
    );
    assert.equal(calls, 1);
  }
  assert.equal(
    (await writeReaction(async () => ({ other: true }), hit, "eyes", "add"))
      .kind,
    "unconfirmed",
  );
});
test("無効な対象・emojiでは送信0回", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return { ok: true };
  };
  assert.equal(
    (await writeReaction(api, { ...hit, channelId: "bad?" }, "eyes", "add"))
      .kind,
    "failed",
  );
  assert.equal((await writeReaction(api, hit, "✅", "add")).kind, "failed");
  assert.equal(calls, 0);
});
