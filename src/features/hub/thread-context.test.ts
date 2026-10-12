import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../slack/identity.ts";
import type { ApiCall } from "../../slack/slack-api.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import type { Hit } from "../../slack/hits.ts";
import {
  cachedThreadContext,
  fetchThreadContext,
  ThreadContextError,
  THREAD_CACHE_MS,
} from "./thread-context.ts";

const ts = (n: number) => `${n}.000000`;
const hit: Hit = {
  key: "C1:3.000000",
  channelId: "C1",
  channelKind: "channel",
  channelName: "dev",
  ts: ts(3),
  threadTs: ts(1),
  text: "選択本文",
  permalink: "",
  mentionsSelf: false,
};
const row = (n: number, text = `body-${n}`) => ({
  ts: ts(n),
  thread_ts: ts(1),
  user: "U2",
  text,
});
const identity = {
  teamId: "T1",
  userId: "U1",
  user: "me",
  team: "team",
  url: "https://example.test",
};
const session = (api: ApiCall): Session => ({
  canFetch: true,
  display: identity,
  fetchAs: identity,
  api,
});
const failure = (kind: string) => (error: unknown) =>
  error instanceof ThreadContextError && error.failure.kind === kind;

test("選択時刻までの同じスレッドを取得し、未来を除いて小数まで降順で並べる", async () => {
  const s = session(async (method, params, options) => {
    assert.equal(method, "conversations.replies");
    assert.deepEqual(params, {
      channel: "C1",
      ts: ts(1),
      latest: ts(3),
      inclusive: true,
      limit: 15,
    });
    assert.equal(options?.signal?.aborted, false);
    return {
      messages: [row(1), row(2), { ...row(2), ts: "2.000001" }, row(3), row(4)],
    };
  });
  const data = await fetchThreadContext(
    s,
    hit,
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual(
    data.messages.map((item) => item.ts),
    [ts(3), "2.000001", ts(2), ts(1)],
  );
  assert.equal(data.isThread, true);
  assert.equal(data.messages[0].channelKind, "channel");
  assert.equal(data.messages.at(-1)?.threadTs, undefined);
});

test("単発投稿と親を区別し、親tsのない返信でも応答で親を確かめる", async () => {
  const single = { ...hit, ts: ts(1), threadTs: undefined };
  const plain = await fetchThreadContext(
    session(async () => ({ messages: [{ ts: ts(1), text: "single" }] })),
    single,
  );
  assert.equal(plain.isThread, false);
  const parent = await fetchThreadContext(
    session(async () => ({ messages: [{ ...row(1), reply_count: 3 }] })),
    single,
  );
  assert.equal(parent.isThread, true);
  const reply = await fetchThreadContext(
    session(async (_, params) => {
      assert.equal(params?.ts, hit.ts);
      return { messages: [row(1), row(3)] };
    }),
    { ...hit, threadTs: undefined },
  );
  assert.equal(reply.rootTs, ts(1));
});

test("1操作1ページで続きを読み、重複を除いてキャッシュに進捗を保存する", async () => {
  let calls = 0;
  const s = session(async (_, params) => {
    calls++;
    assert.equal(params?.cursor, calls === 1 ? undefined : "next");
    return calls === 1
      ? {
          messages: [row(1), row(2)],
          has_more: true,
          response_metadata: { next_cursor: "next" },
        }
      : { messages: [row(2), row(3)] };
  });
  const first = await fetchThreadContext(s, hit);
  assert.equal(calls, 1);
  assert.equal(first.cursor, "next");
  const second = await fetchThreadContext(s, hit, first);
  assert.deepEqual(
    second.messages.map((item) => item.ts),
    [ts(3), ts(2), ts(1)],
  );
  assert.equal(second.cursor, undefined);
  assert.equal(cachedThreadContext(s, hit), second);
  await fetchThreadContext(s, hit, second);
  assert.equal(calls, 2);
});

test("10ページ・150件で止まり、上限後にAPIを追加で呼ばない", async () => {
  let calls = 0;
  const selected = { ...hit, ts: ts(1000) };
  const s = session(async () => {
    const start = calls++ * 15 + 1;
    return {
      messages: Array.from({ length: 15 }, (_, i) => row(start + i)),
      has_more: true,
      response_metadata: { next_cursor: `page-${calls}` },
    };
  });
  let data = await fetchThreadContext(s, selected);
  for (let i = 1; i < 10; i++)
    data = await fetchThreadContext(s, selected, data);
  assert.equal(data.pages, 10);
  assert.equal(data.messages.length, 150);
  assert.equal(data.capped, true);
  assert.equal(data.cursor, undefined);
  await fetchThreadContext(s, selected, data);
  assert.equal(calls, 10);
});

test("不正な親・別スレッド・別会話・本文・カーソルを採用しない", async () => {
  for (const messages of [
    [],
    [row(2)],
    [row(1), { ...row(3), thread_ts: ts(2) }],
    [row(1), { ...row(3), channel: "C2" }],
    [row(1), { ...row(3), text: 4 }],
    [{ ...row(1), thread_ts: ts(2) }],
  ]) {
    const s = session(async () => ({ messages }));
    await assert.rejects(fetchThreadContext(s, hit), failure("invalid"));
    assert.equal(cachedThreadContext(s, hit), undefined);
  }
  for (const response_metadata of [{}, { next_cursor: 2 }]) {
    await assert.rejects(
      fetchThreadContext(
        session(async () => ({
          messages: [row(1)],
          has_more: true,
          response_metadata,
        })),
        hit,
      ),
      failure("invalid"),
    );
  }
});

test("カーソル循環は途中結果を完了扱いせず、選択投稿が欠ける完了応答も拒否する", async () => {
  const s = session(async () => ({
    messages: [row(1)],
    has_more: true,
    response_metadata: { next_cursor: "same" },
  }));
  const first = await fetchThreadContext(s, hit);
  await assert.rejects(fetchThreadContext(s, hit, first), failure("invalid"));
  assert.equal(cachedThreadContext(s, hit), first);
  await assert.rejects(
    fetchThreadContext(
      session(async () => ({ messages: [row(1), row(2)] })),
      hit,
    ),
    failure("missing"),
  );
});

test("2分のキャッシュは本人・チャンネル・選択投稿・認証クライアントで分かれる", async () => {
  const api: ApiCall = async () => ({ messages: [row(1), row(3)] });
  const s = session(api);
  const data = await fetchThreadContext(
    s,
    hit,
    undefined,
    undefined,
    () => 100,
  );
  assert.equal(cachedThreadContext(s, hit, 100 + THREAD_CACHE_MS - 1), data);
  assert.equal(
    cachedThreadContext(
      session(async () => api("conversations.replies")),
      hit,
      101,
    ),
    undefined,
  );
  assert.equal(
    cachedThreadContext(
      { ...s, display: { ...identity, userId: "U3" } },
      hit,
      101,
    ),
    undefined,
  );
  assert.equal(
    cachedThreadContext(
      { ...s, display: { ...identity, teamId: "T2" } },
      hit,
      101,
    ),
    undefined,
  );
  assert.equal(
    cachedThreadContext(s, { ...hit, channelId: "C2" }, 101),
    undefined,
  );
  assert.equal(cachedThreadContext(s, { ...hit, ts: ts(2) }, 101), undefined);
  assert.equal(
    cachedThreadContext(
      { ...s, canFetch: false, fetchAs: undefined },
      hit,
      101,
    ),
    undefined,
  );
  assert.equal(cachedThreadContext(s, hit, 100 + THREAD_CACHE_MS), undefined);
});

test("中断後に返った応答を保存せず、認証未確認ではAPIを呼ばない", async () => {
  const controller = new AbortController();
  const s = session(async () => {
    controller.abort();
    return { messages: [row(1), row(3)] };
  });
  await assert.rejects(
    fetchThreadContext(s, hit, undefined, controller.signal),
  );
  assert.equal(cachedThreadContext(s, hit), undefined);
  let calls = 0;
  await assert.rejects(
    fetchThreadContext(
      {
        ...session(async () => {
          calls++;
          return {};
        }),
        canFetch: false,
        fetchAs: undefined,
      },
      hit,
    ),
  );
  assert.equal(calls, 0);
});

test("429の待機を別のスレッドにも適用し、期限まで再通信しない", async () => {
  let calls = 0;
  const s = session(async () => {
    calls++;
    if (calls === 1) throw new SlackApiError("rate_limited", "hidden", 30);
    return { messages: [row(1), row(3)] };
  });
  await assert.rejects(
    fetchThreadContext(s, hit, undefined, undefined, () => 1000),
    failure("rate"),
  );
  await assert.rejects(
    fetchThreadContext(
      s,
      { ...hit, channelId: "C2" },
      undefined,
      undefined,
      () => 2000,
    ),
    failure("rate"),
  );
  assert.equal(calls, 1);
  await fetchThreadContext(s, hit, undefined, undefined, () => 31000);
  assert.equal(calls, 2);
});

test("権限不足・削除・通信失敗を区別し、例外の生本文は外へ返さない", async () => {
  for (const [code, kind] of [
    ["missing_scope", "scope"],
    ["thread_not_found", "missing"],
    ["access_denied", "missing"],
    ["unknown", "failed"],
  ]) {
    await assert.rejects(
      fetchThreadContext(
        session(async () => {
          throw new SlackApiError("api", "secret body", undefined, code);
        }),
        hit,
      ),
      failure(kind),
    );
  }
});

test("未送信の待機は失敗でなく再開時刻つきのrateとして表示する", async () => {
  const error = new SlackApiError("deferred", "wait", 60);
  error.retryAt = 61000;
  await assert.rejects(
    fetchThreadContext(
      session(async (_method, _params, options) => {
        assert.equal(options?.source, "thread-context");
        assert.equal(options?.deadlineAt, 16000);
        throw error;
      }),
      hit,
      undefined,
      undefined,
      () => 1000,
    ),
    (error: unknown) =>
      error instanceof ThreadContextError &&
      error.failure.kind === "rate" &&
      error.failure.retryAt === 61000,
  );
});
