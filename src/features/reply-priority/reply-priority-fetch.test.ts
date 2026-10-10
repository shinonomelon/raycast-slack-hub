import test from "node:test";
import assert from "node:assert/strict";
import { createReplyScan } from "./reply-priority-fetch.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
const at = 200000000;
const identity = { teamId: "T1", userId: "SELF" };
const msg = (i: number) => ({
  ts: `${200000 - i}.000000`,
  user: "OTHER",
  text: "<@SELF>お願い",
  thread_ts: `${200000 - i}.000000`,
  channel: { id: `C${i}` },
});
test("21候補FIFO、2ページ目の自分投稿、続きを確認で先頭を再取得しない", async () => {
  const seen: string[] = [];
  const api: ApiCall = async (method, p = {}) => {
    if (method === "search.messages")
      return {
        messages: {
          matches: String(p.query).startsWith("to:")
            ? []
            : Array.from({ length: 21 }, (_, i) => msg(i)),
          paging: { pages: 1 },
        },
      };
    seen.push(`${p.channel}:${p.cursor ?? "first"}`);
    return p.cursor
      ? {
          messages: [
            {
              ts: "200000.000001",
              thread_ts: p.ts,
              user: "SELF",
              text: "回答",
            },
          ],
          response_metadata: {},
        }
      : {
          messages: [{ ts: p.ts, user: "OTHER", text: "親" }],
          response_metadata: { next_cursor: "next" },
        };
  };
  const scan = createReplyScan({ api, identity, now: () => at + 1 });
  const first = await scan.start(1);
  assert.equal(first.calls.replies, 20);
  assert.equal(first.pendingCount, 21);
  await scan.continue();
  assert.equal(seen[20], "C20:first");
  assert.equal(new Set(seen).size, seen.length);
  const final = await scan.continue();
  assert.equal(final.pendingCount, 0);
  assert.equal(final.candidates[0].evidence.kind, "self-post-after");
});
test("429を永続pauseにしてRetryAfter前の呼び出しゼロ", async () => {
  let time = at,
    count = 0,
    saved = 0;
  const api: ApiCall = async (method) => {
    count++;
    if (method === "search.messages")
      return { messages: { matches: [msg(1)] } };
    throw new SlackApiError("rate_limited", "rate", 30);
  };
  const scan = createReplyScan({
    api,
    identity,
    now: () => time,
    savePause: (until) => {
      saved = until;
    },
  });
  const first = await scan.start();
  assert.equal(first.candidates[0].evidence.kind, "unknown");
  assert.equal(saved, at + 30000);
  const prior = count;
  await scan.continue();
  assert.equal(count, prior);
  time += 30000;
  await scan.continue();
  assert.ok(count > prior);
});
test("403・タイムアウト・cursor失効・検索上限は確認待ち", async () => {
  for (const error of [
    new SlackApiError("http", "403"),
    new SlackApiError("timeout", "timeout"),
    new SlackApiError("api", "cursor", undefined, "invalid_cursor"),
  ]) {
    const scan = createReplyScan({
      identity,
      now: () => at,
      api: async (m) => {
        if (m === "search.messages")
          return { messages: { matches: [msg(1)], paging: { pages: 3 } } };
        throw error;
      },
    });
    const result = await scan.start();
    assert.equal(result.searchCapped, true);
    assert.equal(result.calls.search, 4);
    assert.equal(result.candidates[0].evidence.kind, "unknown");
  }
});
test("60秒予算で次を呼ばず未完了cursorは未知、時間固定で再開", async () => {
  let time = at;
  let historyCalls = 0;
  const scan = createReplyScan({
    identity,
    now: () => time,
    api: async (m) => {
      if (m === "search.messages")
        return { messages: { matches: [msg(1), msg(2)] } };
      historyCalls++;
      time += 60000;
      return { messages: [], response_metadata: { next_cursor: "next" } };
    },
  });
  const result = await scan.start();
  assert.equal(historyCalls, 1);
  assert.equal(result.pendingCount, 2);
  assert.equal(result.asOf, "200000.000000");
  await scan.continue();
  assert.equal(historyCalls, 2);
  assert.equal(scan.snapshot().asOf, result.asOf);
});
test("通常DMの検索候補を原文で確定し統合、別スレッド返信を除外する", async () => {
  const dm = (ts: string, text: string) => ({
    ts,
    user: "OTHER",
    text,
    channel: { id: "D1", is_im: true },
  });
  const scan = createReplyScan({
    identity,
    now: () => at,
    api: async (m, p = {}) => {
      if (m === "search.messages")
        return {
          messages: {
            matches: String(p.query).startsWith("to:")
              ? [dm("199999.000000", "依頼1"), dm("200000.000000", "依頼2")]
              : [],
          },
        };
      if (p.oldest === p.latest)
        return { messages: [dm(String(p.oldest), "原文")] };
      return {
        messages: [
          dm("199999.000000", "依頼1"),
          dm("200000.000000", "依頼2"),
          {
            ts: "199999.500000",
            text: "別スレッド回答",
            user: "SELF",
            thread_ts: "199900.000000",
          },
        ],
        response_metadata: {},
      };
    },
  });
  const result = await scan.start();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].key, "T1:SELF:D1:dm");
  assert.equal(result.candidates[0].anchorTs, "200000.000000");
  assert.equal(result.candidates[0].firstPendingTs, "199999.000000");
  assert.equal(result.candidates[0].evidence.kind, "no-self-post");
  assert.equal(result.calls.history, 3);
});
test("7日scan境界は固定asOfから厳密計算、中断後は新規callゼロ", async () => {
  const abort = new AbortController();
  let count = 0;
  const scan = createReplyScan({
    identity,
    now: () => 800000000,
    signal: abort.signal,
    api: async () => {
      count++;
      return { messages: { matches: [] } };
    },
  });
  const result = await scan.start(7);
  assert.equal(result.since, "195200.000000");
  assert.equal(result.asOf, "800000.000000");
  abort.abort();
  const old = count;
  await scan.continue();
  assert.equal(count, old);
});
test("未取得ページの再依頼があるため途中の自己投稿だけでは除外しない", async () => {
  let time = at;
  const target = {
    ts: "199150.000000",
    thread_ts: "199100.000000",
    user: "OTHER",
    text: "<@SELF>依頼",
    channel: { id: "C1" },
  };
  const scan = createReplyScan({
    identity,
    now: () => time,
    api: async (method, p = {}) => {
      if (method === "search.messages")
        return { messages: { matches: [target] } };
      if (!p.cursor) {
        time += 60000;
        return {
          messages: [
            { ts: "199100.000000", user: "OTHER", text: "親" },
            target,
            {
              ts: "199160.000000",
              thread_ts: "199100.000000",
              user: "SELF",
              text: "回答",
            },
          ],
          response_metadata: { next_cursor: "last" },
        };
      }
      return {
        messages: [
          {
            ts: "199180.000000",
            thread_ts: "199100.000000",
            user: "OTHER",
            text: "<@SELF>再依頼",
          },
        ],
        response_metadata: {},
      };
    },
  });
  const first = await scan.start();
  assert.equal(first.candidates[0].evidence.kind, "unknown");
  assert.equal(first.pendingCount, 1);
  const complete = await scan.continue();
  assert.equal(complete.candidates[0].anchorTs, "199180.000000");
  assert.equal(complete.candidates[0].evidence.kind, "no-self-post");
});
test("先行ページの読み取り欠落は最終ページが正常でも確認待ちを維持する", async () => {
  const target = {
    ts: "199150.000000",
    thread_ts: "199100.000000",
    user: "OTHER",
    text: "<@SELF>依頼",
    channel: { id: "C1" },
  };
  const scan = createReplyScan({
    identity,
    now: () => at,
    api: async (method, p = {}) => {
      if (method === "search.messages")
        return { messages: { matches: [target] } };
      if (!p.cursor)
        return {
          messages: [
            { ts: "199100.000000", user: "OTHER", text: "親" },
            target,
            { user: "SELF", text: "時刻欠落" },
          ],
          response_metadata: { next_cursor: "last" },
        };
      return {
        messages: [
          {
            ts: "199180.000000",
            thread_ts: "199100.000000",
            user: "OTHER",
            text: "追記",
          },
        ],
        response_metadata: {},
      };
    },
  });
  const result = await scan.start();
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.candidates[0].evidence, {
    kind: "unknown",
    reason: "partial",
  });
  assert.equal(result.candidates[0].contextIncomplete, true);
});
