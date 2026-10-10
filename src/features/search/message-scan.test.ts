import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMessageScan,
  messagePlanKey,
  type MessageScanPorts,
} from "./message-scan.ts";
import type { Hit } from "../../slack/hits.ts";
import type { MessageSearchPlan } from "../search-scope/search-plan.ts";
import type { Pause } from "./search-gate.ts";
const hit = (
  id: number,
  channelId = "C1",
  userId = "UA",
  ts = `${100 + id}.000000`,
): Hit => ({
  key: `${channelId}:${ts}`,
  channelId,
  userId,
  ts,
  text: `本文${id}`,
  channelKind: "channel",
  permalink: "",
  mentionsSelf: false,
});
const plan = (
  queries = ["q1"],
  channelIds: "all" | string[] = ["C1"],
): MessageSearchPlan => ({
  queries,
  resolvedQuery: "本文",
  conflicts: [],
  empty: false,
  canSearch: true,
  scope: { channelIds, senderId: "UA", fingerprint: "f1" },
});
function ports(search: MessageScanPorts["search"], clock = () => 1_000_000) {
  let pause: Pause | undefined;
  return {
    search,
    now: clock,
    readPause: () => pause,
    writePause: (value: Pause) => {
      pause = value;
      return value;
    },
  };
}
test("1ページ目を公平に回しround4回で止め、再開時は未検索を先に固定時刻で取得", async () => {
  const calls: string[] = [];
  let now = 1_000_000;
  const scan = createMessageScan(
    "本文",
    plan(["a", "b", "c", "d", "e"]),
    ports(
      async (query, page) => {
        calls.push(
          `${query.replace(/ before:\d{4}-\d{2}-\d{2}$/, "")}:${page}`,
        );
        return { kind: "ok", hits: [], capped: page === 1 };
      },
      () => now,
    ),
  );
  let result = await scan.run(new AbortController().signal);
  assert.deepEqual(calls, ["a:1", "b:1", "c:1", "d:1"]);
  assert.equal(result.calls, 4);
  now += 2000;
  result = await scan.run(new AbortController().signal);
  assert.deepEqual(calls.slice(4), ["e:1", "a:2", "b:2", "c:2"]);
  assert.equal(result.asOf, "1000.000000");
  await scan.run(new AbortController().signal);
  assert.deepEqual(calls.slice(8), ["d:2", "e:2"]);
  await scan.run(new AbortController().signal);
  assert.equal(calls.length, 10);
});
test("channel/user/asOfを結果でも検証し、channel+ts重複を統合して新着を除く", async () => {
  const scan = createMessageScan(
    "本文",
    plan(["a", "b"]),
    ports(async () => ({
      kind: "ok",
      capped: false,
      hits: [
        hit(1),
        hit(1),
        hit(2, "C2"),
        hit(3, "C1", "UB"),
        hit(4, "C1", "UA", "1000.000001"),
        { ...hit(5), channelKind: "im" },
      ],
    })),
  );
  assert.deepEqual(
    (await scan.run(new AbortController().signal)).hits.map((h) => h.ts),
    ["101.000000"],
  );
});
test("保持400件で以降の新規検索を止め、ページ途中省略数を示す", async () => {
  let calls = 0;
  const scan = createMessageScan(
    "本文",
    plan(["a", "b", "c", "d", "e", "f"]),
    ports(async () => {
      const call = calls++;
      const first = call === 3 ? 250 : call * 100;
      return {
        kind: "ok",
        capped: false,
        hits: Array.from({ length: 100 }, (_, n) => hit(first + n)),
      };
    }),
  );
  assert.equal((await scan.run(new AbortController().signal)).hits.length, 350);
  const result = await scan.run(new AbortController().signal);
  assert.equal(result.hits.length, 400);
  assert.equal(result.omittedCount, 50);
  assert.equal(result.capped, true);
  assert.equal(calls, 5);
  await scan.run(new AbortController().signal);
  assert.equal(calls, 5);
});
test("60秒上限は次のcallを止め、残り時間をAPI timeoutへ渡す", async () => {
  let now = 1_000_000;
  const timeouts: number[] = [];
  const scan = createMessageScan(
    "本文",
    plan(["a", "b", "c", "d"]),
    ports(
      async (_q, _p, _signal, timeout) => {
        timeouts.push(timeout);
        now += 29000;
        return { kind: "ok", capped: false, hits: [] };
      },
      () => now,
    ),
  );
  const result = await scan.run(new AbortController().signal);
  assert.deepEqual(timeouts, [15000, 15000, 2000]);
  assert.equal(result.pendingCount, 1);
});
test("一部失敗でも成功候補を残し、次roundに失敗ページだけを再試行", async () => {
  let failed = true;
  const calls: string[] = [];
  const scan = createMessageScan(
    "本文",
    plan(["a", "b"]),
    ports(async (q) => {
      const originalQuery = q.replace(/ before:\d{4}-\d{2}-\d{2}$/, "");
      calls.push(originalQuery);
      if (originalQuery === "a" && failed) {
        failed = false;
        return {
          kind: "failed",
          failure: { kind: "error", message: "permission" },
        };
      }
      return {
        kind: "ok",
        capped: false,
        hits: [hit(originalQuery === "a" ? 1 : 2)],
      };
    }),
  );
  const partial = await scan.run(new AbortController().signal);
  assert.equal(partial.hits.length, 1);
  assert.deepEqual(partial.failedQueries, ["a"]);
  const completed = await scan.run(new AbortController().signal);
  assert.deepEqual(calls, ["a", "b", "a"]);
  assert.equal(completed.hits.length, 2);
  assert.equal(completed.partial, false);
});
test("429停止を別scanも共有し、待機中call0で期限後に同じページから再開", async () => {
  let now = 1_000_000,
    calls = 0;
  const shared = ports(
    async () => {
      calls++;
      return calls === 1
        ? {
            kind: "failed",
            failure: {
              kind: "rate_limited",
              message: "rate",
              pause: { until: now + 60000, cause: "rate_limited" },
            },
          }
        : { kind: "ok", capped: false, hits: [hit(1)] };
    },
    () => now,
  );
  const scan = createMessageScan("本文", plan(), shared);
  assert.equal(
    (await scan.run(new AbortController().signal)).pausedUntil,
    now + 60000,
  );
  await createMessageScan("別条件", plan(["other"]), shared).run(
    new AbortController().signal,
  );
  await scan.run(new AbortController().signal);
  assert.equal(calls, 1);
  now += 60000;
  assert.equal((await scan.run(new AbortController().signal)).hits.length, 1);
  assert.equal(calls, 2);
});
test("中断後の遅延結果を採用せず、空計画のcall0と同expressionの条件世代を区別", async () => {
  const controller = new AbortController();
  const scan = createMessageScan(
    "本文",
    plan(),
    ports(async () => {
      controller.abort();
      return { kind: "ok", capped: false, hits: [hit(1)] };
    }),
  );
  assert.equal((await scan.run(controller.signal)).hits.length, 0);
  let calls = 0;
  const empty = createMessageScan(
    "本文",
    { ...plan([]), canSearch: false, empty: true },
    ports(async () => {
      calls++;
      return { kind: "ok", hits: [], capped: false };
    }),
  );
  await empty.run(new AbortController().signal);
  assert.equal(calls, 0);
  assert.notEqual(
    messagePlanKey("本文", plan()),
    messagePlanKey("本文", {
      ...plan(),
      scope: { ...plan().scope, fingerprint: "changed" },
    }),
  );
});

test("各検索の2ページ上限を超えるpagingは上限状態を残し3ページ目を呼ばない", async () => {
  const pages: number[] = [];
  const scan = createMessageScan(
    "本文",
    plan(),
    ports(async (_q, page) => {
      pages.push(page);
      return { kind: "ok", hits: [hit(page)], capped: true, pageCount: 5 };
    }),
  );
  const result = await scan.run(new AbortController().signal);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.capped, true);
  assert.equal(result.partial, true);
  await scan.run(new AbortController().signal);
  assert.deepEqual(pages, [1, 2]);
});

test("固定UTC2日後のbeforeを全ページへ送り、既存beforeと引用を保持しlocal時刻境界も守る", async () => {
  let now = Date.UTC(2026, 9, 10, 23, 30);
  const initial = now;
  const sent: string[] = [];
  const query = '"before:説明" before:2026-10-01 in:<#C1>';
  const scan = createMessageScan(
    query,
    plan([query, "b", "c", "d", "e"]),
    ports(
      async (q, page) => {
        sent.push(q);
        return {
          kind: "ok",
          capped: page === 1,
          hits: [
            hit(1, "C1", "UA", `${initial / 1000}.000000`),
            hit(2, "C1", "UA", `${initial / 1000}.000001`),
          ],
        };
      },
      () => now,
    ),
  );
  await scan.run(new AbortController().signal);
  now += 3 * 24 * 60 * 60 * 1000;
  const result = await scan.run(new AbortController().signal);
  assert.equal(sent[0], query + " before:2026-10-12");
  assert.ok(sent.every((q) => q.endsWith(" before:2026-10-12")));
  assert.equal(result.hits.length, 1);
  assert.equal(result.asOf, `${initial / 1000}.000000`);
});
