import test from "node:test";
import assert from "node:assert/strict";
import {
  createReplyDecisionCache,
  openCachedReplyScan,
  replyBinding,
  REPLY_RESULT_TTL,
  reusableReplyAI,
} from "./reply-priority-cache.ts";
import {
  createReplyScan,
  type ReplyScanCheckpoint,
} from "./reply-priority-fetch.ts";
import {
  AI_PROMPT_VERSION,
  JEV_MODEL,
  aiInputHash,
  type AIResult,
} from "./reply-priority-ai.ts";
import { createReplyPriorityStore } from "./reply-priority-store.ts";
import type { ApiCall } from "../../slack/slack-api.ts";

const at = 800000000;
const identity = { teamId: "T1", userId: "SELF" };
const target = (i = 1) => ({
  ts: `${800000 - i}.000000`,
  thread_ts: `${800000 - i}.000000`,
  user: "OTHER",
  text: "<@SELF>確認お願いします",
  channel: { id: `C${i}` },
});
const result: AIResult = {
  neededProbability: 0.9,
  timeScore: 3,
  timeConfidence: 0.9,
  blockingScore: 2,
  blockingConfidence: 0.9,
  reminderProbability: 0.9,
  deadlineUncertainProbability: 0.1,
  contextIncomplete: false,
  model: JEV_MODEL,
  promptVersion: AI_PROMPT_VERSION,
};
function fixture() {
  const values = new Map<string, string>();
  const port = {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let time = at;
  const clock = () => time;
  const cache = createReplyDecisionCache(
    port,
    replyBinding(identity, "fixture-secret-token", "fixture-secret-ai-key"),
    clock,
  );
  let calls = 0;
  const api: ApiCall = async (method, params = {}) => {
    calls++;
    return method === "search.messages"
      ? { messages: { matches: [target()] } }
      : {
          messages: [
            { ts: params.ts, user: "OTHER", text: "<@SELF>確認お願いします" },
          ],
          response_metadata: {},
        };
  };
  return {
    values,
    port,
    cache,
    api,
    clock,
    calls: () => calls,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("期限内reopenで確認状態を復元しSlack取得ゼロ、完了Continueもゼロ", async () => {
  const f = fixture();
  const initial = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  const first = await initial.begin();
  assert.equal(first.candidates[0].evidence.kind, "no-self-post");
  const before = f.calls();
  const reopened = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  assert.equal(reopened.fromCache, true);
  assert.deepEqual(await reopened.begin(), JSON.parse(JSON.stringify(first)));
  await reopened.scan.continue();
  assert.equal(f.calls(), before);
});

test("部分scanのFIFOとcursorを復元し既取得ページを再読しない", async () => {
  const f = fixture();
  const pages: string[] = [];
  const api: ApiCall = async (method, p = {}) => {
    if (method === "search.messages")
      return {
        messages: {
          matches: Array.from({ length: 21 }, (_, i) => target(i + 1)),
        },
      };
    pages.push(`${p.channel}:${p.cursor ?? "first"}`);
    return {
      messages: [{ ts: p.ts, user: "OTHER", text: "親" }],
      response_metadata: p.cursor ? {} : { next_cursor: "last" },
    };
  };
  const first = openCachedReplyScan(f.cache, 1, {
    api,
    identity,
    now: f.clock,
  });
  const snapshot = await first.begin();
  assert.equal(snapshot.pendingCount, 21);
  const restored = openCachedReplyScan(f.cache, 1, {
    api,
    identity,
    now: f.clock,
  });
  assert.equal(restored.fromCache, true);
  await restored.begin();
  assert.equal(pages.length, 20);
  await restored.scan.continue();
  assert.equal(pages[20], "C21:first");
  await restored.scan.continue();
  assert.equal(restored.scan.snapshot().pendingCount, 0);
  assert.equal(restored.scan.snapshot().asOf, snapshot.asOf);
  assert.equal(new Set(pages).size, pages.length);
});

test("最終検索直後のcheckpointからタスクを一度だけ作成する", async () => {
  const f = fixture();
  let boundary: ReplyScanCheckpoint | undefined;
  const scan = createReplyScan({
    api: f.api,
    identity,
    now: f.clock,
    onCheckpoint: (cp) => {
      if (cp.snapshot.calls.search === 2 && !cp.started) boundary = cp;
    },
  });
  await scan.start();
  assert.ok(boundary);
  f.cache.saveScan(1, boundary!);
  const restored = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  await restored.begin();
  const before = f.calls();
  await restored.scan.continue();
  assert.equal(f.calls(), before + 1);
  await restored.scan.continue();
  assert.equal(f.calls(), before + 1);
});

test("処理中closeではshift前の安定checkpointから復元してタスクを失わない", async () => {
  const f = fixture();
  const abort = new AbortController();
  let release!: (value: Record<string, unknown>) => void;
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  const slow: ApiCall = async (method) => {
    if (method === "search.messages")
      return { messages: { matches: [target()] } };
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const initial = openCachedReplyScan(f.cache, 1, {
    api: slow,
    identity,
    now: f.clock,
    signal: abort.signal,
  });
  const pending = initial.begin();
  await inFlight;
  assert.equal(initial.scan.checkpoint()?.queue.length, 1);
  abort.abort();
  release({ messages: [], response_metadata: {} });
  await pending;
  const restored = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  assert.equal(restored.scan.snapshot().pendingCount, 1);
  const before = f.calls();
  await restored.scan.continue();
  assert.equal(f.calls(), before + 1);
  assert.equal(restored.scan.snapshot().pendingCount, 0);
});

test("5分TTLは保存し直しても延長せず、期間分離と明示更新を守る", async () => {
  const f = fixture();
  const one = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  await one.begin();
  const cp = one.scan.checkpoint()!;
  const seven = openCachedReplyScan(f.cache, 7, {
    api: f.api,
    identity,
    now: f.clock,
  });
  assert.equal(seven.fromCache, false);
  await seven.begin();
  assert.equal(f.cache.loadScan(1)?.days, 1);
  assert.equal(f.cache.loadScan(7)?.days, 7);
  const before = f.calls();
  const refresh = openCachedReplyScan(
    f.cache,
    1,
    { api: f.api, identity, now: f.clock },
    true,
  );
  assert.equal(refresh.fromCache, false);
  await refresh.begin();
  assert.ok(f.calls() > before);
  f.advance(REPLY_RESULT_TTL - 1);
  f.cache.saveScan(1, cp);
  assert.ok(f.cache.loadScan(1));
  f.advance(1);
  assert.equal(f.cache.loadScan(1), undefined);
});

test("token・APIキー・本人変更と復元で旧scope結果を再利用しない、生キーは保存しない", async () => {
  const f = fixture();
  const scan = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  await scan.begin();
  const marks = createReplyPriorityStore(f.port, "marks", f.clock);
  marks.set("keep", { kind: "dismissed", anchorTs: "799999.000000", at });
  marks.savePause(at + 30000);
  const changedKey = createReplyDecisionCache(
    f.port,
    replyBinding(identity, "fixture-secret-token", "different-key"),
    f.clock,
  );
  assert.equal(changedKey.loadScan(1), undefined);
  assert.equal(f.cache.loadScan(1), undefined);
  f.cache.saveScan(1, scan.scan.checkpoint()!);
  const changedToken = createReplyDecisionCache(
    f.port,
    replyBinding(identity, "different-token", "fixture-secret-ai-key"),
    f.clock,
  );
  assert.equal(changedToken.loadScan(1), undefined);
  assert.equal(f.cache.loadScan(1), undefined);
  f.cache.saveScan(1, scan.scan.checkpoint()!);
  const other = createReplyDecisionCache(
    f.port,
    replyBinding({ teamId: "T2", userId: "B" }, "other-token", "other-key"),
    f.clock,
  );
  assert.equal(other.loadScan(1), undefined);
  assert.equal(f.cache.loadScan(1), undefined);
  assert.equal(Object.keys(marks.load()).length, 1);
  assert.equal(marks.loadPause(), at + 30000);
  const persisted = [...f.values.values()].join("");
  for (const secret of [
    "fixture-secret-token",
    "fixture-secret-ai-key",
    "different-token",
    "different-key",
    "other-token",
    "other-key",
  ])
    assert.equal(persisted.includes(secret), false);
});

test("破損record・他scope混入・保存失敗では通常取得へ戻る", async () => {
  const f = fixture();
  const initial = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  await initial.begin();
  const slot = "T1:SELF:scan:1";
  const original = f.values.get(slot)!;
  for (const corrupted of [
    "{broken",
    JSON.stringify({
      ...JSON.parse(original),
      checkpoint: {
        ...initial.scan.checkpoint(),
        snapshot: {
          ...initial.scan.snapshot(),
          candidates: [
            { ...initial.scan.snapshot().candidates[0], key: "T2:B:C1:other" },
          ],
        },
      },
    }),
  ]) {
    f.values.set(slot, corrupted);
    assert.equal(f.cache.loadScan(1), undefined);
    const reopened = openCachedReplyScan(f.cache, 1, {
      api: f.api,
      identity,
      now: f.clock,
    });
    assert.equal(reopened.fromCache, false);
    await reopened.begin();
  }
  const broken = createReplyDecisionCache(
    {
      get: () => undefined,
      set: () => {
        throw new Error("disk full");
      },
    },
    replyBinding(identity, "token", "key"),
    f.clock,
  );
  const usable = openCachedReplyScan(broken, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  assert.equal((await usable.begin()).candidates.length, 1);
});

test("AIは入力hash・model・判定版・5分・appliedを検証し復元でAI送信しない", async () => {
  const f = fixture();
  const scan = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  const view = await scan.begin();
  const candidate = view.candidates[0];
  const input = {
    messages: [{ ts: candidate.anchorTs, text: "fixture", userId: "OTHER" }],
    rootTs: candidate.anchorTs,
    anchorTs: candidate.anchorTs,
    selfId: "SELF",
    asOf: view.asOf,
    timezone: "Asia/Tokyo",
    evidenceComplete: true,
  };
  const hash = aiInputHash(input);
  f.cache.saveAI(1, [
    { key: candidate.key, hash, result, scoredAt: at, applied: true },
  ]);
  assert.equal(f.cache.loadAI(1)[0].hash, hash);
  assert.notEqual(
    aiInputHash({
      ...input,
      messages: [{ ...input.messages[0], text: "changed" }],
    }),
    hash,
  );
  assert.equal(f.cache.loadAI(7).length, 0);
  const restored = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  const before = f.calls();
  await restored.begin();
  assert.equal(f.calls(), before);
  assert.equal(f.cache.loadAI(1)[0].applied, true);
  f.cache.saveAI(1, [
    { key: candidate.key, hash, result, scoredAt: at, applied: false },
  ]);
  assert.equal(f.cache.loadAI(1)[0].applied, false);
  assert.equal(
    reusableReplyAI(f.cache.loadAI(1)[0], hash, at + REPLY_RESULT_TTL - 1),
    true,
  );
  assert.equal(
    reusableReplyAI(f.cache.loadAI(1)[0], "changed-hash", at),
    false,
  );
  assert.equal(
    reusableReplyAI(f.cache.loadAI(1)[0], hash, at + REPLY_RESULT_TTL),
    false,
  );
  for (const invalid of [
    { ...result, model: "other" },
    { ...result, promptVersion: "other" },
  ]) {
    f.cache.saveAI(1, [
      {
        key: candidate.key,
        hash,
        result: invalid,
        scoredAt: at,
        applied: true,
      },
    ]);
    assert.equal(f.cache.loadAI(1).length, 0);
  }
  f.cache.saveAI(1, [
    { key: candidate.key, hash, result, scoredAt: at, applied: true },
  ]);
  f.advance(REPLY_RESULT_TTL);
  assert.equal(f.cache.loadAI(1).length, 0);
});

test("入力hashが同じでも期限後は再送候補、OFFから再ONの期限内判定は再利用する", () => {
  const f = fixture();
  const inputHash = "a".repeat(64);
  const entry = {
    key: "T1:SELF:C1:799999.000000",
    hash: inputHash,
    result,
    scoredAt: at,
    applied: true,
  };
  f.cache.saveAI(1, [entry]);
  f.cache.saveAI(
    1,
    f.cache.loadAI(1).map((e) => ({ ...e, applied: false })),
  );
  const off = f.cache.loadAI(1)[0];
  assert.equal(off.applied, false);
  assert.equal(reusableReplyAI(off, inputHash, at + 1), true);
  assert.equal(reusableReplyAI(off, inputHash, at + REPLY_RESULT_TTL), false);
});

test("null消去だけが失敗してもAからBを経由した旧本文・AI結果を復活させない", async () => {
  const f = fixture();
  const initial = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  const snapshot = await initial.begin();
  f.cache.saveAI(1, [
    {
      key: snapshot.candidates[0].key,
      hash: "a".repeat(64),
      result,
      scoredAt: at,
      applied: true,
    },
  ]);
  const oldEpoch = JSON.parse(f.values.get("active-binding")!).epoch;
  const rejectDelete = {
    get: f.port.get,
    set: (key: string, value: string) => {
      if (value === "null") throw new Error("delete denied");
      f.port.set(key, value);
    },
  };
  const b = createReplyDecisionCache(
    rejectDelete,
    replyBinding({ teamId: "T2", userId: "B" }, "b-token", "b-key"),
    f.clock,
  );
  assert.equal(b.activate(), false);
  assert.notEqual(JSON.parse(f.values.get("active-binding")!).epoch, oldEpoch);
  const a = createReplyDecisionCache(
    rejectDelete,
    replyBinding(identity, "fixture-secret-token", "fixture-secret-ai-key"),
    f.clock,
  );
  assert.equal(a.loadScan(1), undefined);
  assert.deepEqual(a.loadAI(1), []);
  assert.equal(f.cache.loadScan(1), undefined);
  const reopened = openCachedReplyScan(a, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  assert.equal(reopened.fromCache, false);
  assert.equal((await reopened.begin()).candidates.length, 1);
});

test("binding更新や保存失敗を観測したインスタンスは復元せず通常取得する", async () => {
  const f = fixture();
  const initial = openCachedReplyScan(f.cache, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  await initial.begin();
  let fail = true;
  const failingPort = {
    get: f.port.get,
    set: (key: string, value: string) => {
      if (fail) throw new Error("write denied");
      f.port.set(key, value);
    },
  };
  const same = createReplyDecisionCache(
    failingPort,
    replyBinding(identity, "fixture-secret-token", "fixture-secret-ai-key"),
    f.clock,
  );
  assert.equal(same.loadScan(1), undefined);
  fail = false;
  assert.equal(same.loadScan(1), undefined);
  assert.equal(same.activate(), false);
  const fallback = openCachedReplyScan(same, 1, {
    api: f.api,
    identity,
    now: f.clock,
  });
  const before = f.calls();
  await fallback.begin();
  assert.ok(f.calls() > before);
});
