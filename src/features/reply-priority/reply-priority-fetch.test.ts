import test from "node:test";
import assert from "node:assert/strict";
import { createReplyScan } from "./reply-priority-fetch.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
const at = 200000000;
const identity = { teamId: "T1", userId: "USELF" };
const msg = (i: number) => ({
  ts: `${200000 - i}.000000`,
  user: "OTHER",
  text: "<@USELF>お願い",
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
              user: "USELF",
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
            user: "USELF",
            thread_ts: "199900.000000",
          },
        ],
        response_metadata: {},
      };
    },
  });
  const result = await scan.start();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].key, "T1:USELF:D1:dm");
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
    text: "<@USELF>依頼",
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
              user: "USELF",
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
            text: "<@USELF>再依頼",
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
    text: "<@USELF>依頼",
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
            { user: "USELF", text: "時刻欠落" },
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

test("チャンネル範囲は直接メンションだけ、各1ページを先に4回まで取得して再開する", async () => {
  const scope = {
    channelIds: ["C1", "C2", "C3", "C4", "C5"],
    senderId: "UA",
    fingerprint: "scope",
  };
  const seen: { query: string; page: unknown }[] = [];
  const scan = createReplyScan({
    identity: { teamId: "T1", userId: "U1" },
    scope,
    now: () => at,
    api: async (_method, params = {}) => {
      seen.push({ query: String(params.query), page: params.page });
      return { messages: { matches: [], paging: { pages: 2 } } };
    },
  });
  const first = await scan.start();
  assert.equal(seen.length, 4);
  assert.equal(first.pendingCount, 5);
  assert.ok(
    seen.every(
      (call) =>
        call.page === 1 &&
        call.query.includes("from:<@UA>") &&
        !call.query.includes("to:me"),
    ),
  );
  await scan.continue();
  assert.equal(seen[4].page, 1);
  assert.ok(seen.slice(5).every((call) => call.page === 2));
});

test("空scopeは検索しない、範囲を変えても共有pause中の通信はゼロ", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return {};
  };
  const empty = createReplyScan({
    api,
    identity: { teamId: "T1", userId: "U1" },
    scope: { channelIds: [], fingerprint: "empty" },
    now: () => at,
  });
  await empty.start();
  const paused = createReplyScan({
    api,
    identity: { teamId: "T1", userId: "U1" },
    scope: { channelIds: ["C1"], fingerprint: "c1" },
    now: () => at,
    loadPause: () => at + 1000,
  });
  await paused.start();
  assert.equal(calls, 0);
});

test("恒久失敗チャンネルを後回しにし、他チャンネルの候補と文脈を取得する", async () => {
  const seen: string[] = [];
  const scan = createReplyScan({
    identity: { teamId: "T1", userId: "U1" },
    scope: { channelIds: ["C1", "C2"], fingerprint: "scope" },
    now: () => at,
    api: async (method, params = {}) => {
      if (method === "search.messages") {
        const query = String(params.query);
        seen.push(query);
        if (query.includes("<#C1>")) throw new SlackApiError("api", "denied");
        return {
          messages: {
            matches: [
              {
                ts: "199999.000000",
                thread_ts: "199999.000000",
                user: "UA",
                text: "<@U1>お願い",
                channel: { id: "C2" },
              },
            ],
          },
        };
      }
      return {
        messages: [{ ts: "199999.000000", user: "UA", text: "<@U1>お願い" }],
      };
    },
  });
  const first = await scan.start();
  assert.equal(seen.length, 2);
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].evidence.kind, "no-self-post");
  assert.equal(first.pendingCount, 1);
  assert.equal(first.failedQueries?.length, 1);
  await scan.continue();
  assert.equal(seen.length, 3);
});

test("一部失敗は再試行成功で解消し、beforeはUTC基準の2日先で取りこぼしを防ぐ", async () => {
  const instant = Date.parse("2026-10-10T09:59:00.000Z");
  let failed = true;
  let query = "";
  const scan = createReplyScan({
    identity: { teamId: "T1", userId: "U1" },
    scope: { channelIds: ["C1"], fingerprint: "scope" },
    now: () => instant,
    api: async (_method, params = {}) => {
      query = String(params.query);
      if (failed) throw new SlackApiError("api", "denied");
      return { messages: { matches: [] } };
    },
  });
  const partial = await scan.start();
  assert.equal(partial.searchIncomplete, true);
  assert.equal(partial.failedQueries?.length, 1);
  assert.match(query, /before:2026-10-12/);
  failed = false;
  const complete = await scan.continue();
  assert.equal(complete.searchIncomplete, false);
  assert.equal(complete.failedQueries?.length, 0);
  assert.equal(complete.pendingCount, 0);
});

test("C1失敗後C2の取得待ちで閉じても再開データにC1再試行を残す", async () => {
  const scope = { channelIds: ["C1", "C2"], fingerprint: "scope" };
  const account = { teamId: "T1", userId: "U1" };
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const scan = createReplyScan({
    identity: account,
    scope,
    now: () => at,
    signal: controller.signal,
    api: async (_method, params = {}) => {
      if (String(params.query).includes("<#C1>"))
        throw new SlackApiError("api", "denied");
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: { matches: [] } };
    },
  });
  const running = scan.start();
  await waiting;
  const checkpoint = scan.checkpoint()!;
  assert.equal(checkpoint.searches.length, 2);
  assert.equal(checkpoint.snapshot.pendingCount, 2);
  assert.ok(checkpoint.searches.some((task) => task.query.includes("<#C1>")));
  controller.abort();
  release();
  await running;
  const seen: string[] = [];
  const restored = createReplyScan({
    identity: account,
    scope,
    now: () => at,
    restore: checkpoint,
    api: async (_method, params = {}) => {
      seen.push(String(params.query));
      return { messages: { matches: [] } };
    },
  });
  const complete = await restored.continue();
  assert.equal(seen.length, 2);
  assert.ok(seen.some((query) => query.includes("<#C1>")));
  assert.equal(complete.pendingCount, 0);
  assert.equal(complete.searchIncomplete, false);
});
