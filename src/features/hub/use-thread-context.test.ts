import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as thread from "./thread-context.ts";
import type { ThreadDetail } from "./use-thread-context.ts";
import type { Hit } from "../../slack/hits.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";

const hit: Hit = {
  key: "C1:3.000000",
  channelId: "C1",
  channelKind: "channel",
  ts: "3.000000",
  threadTs: "1.000000",
  text: "selected",
  permalink: "",
  mentionsSelf: false,
};
const row = (n: number) => ({
  ts: `${n}.000000`,
  thread_ts: "1.000000",
  text: `body-${n}`,
});
const complete = { messages: [row(1), row(3)] };
const partial = {
  messages: [row(1)],
  has_more: true,
  response_metadata: { next_cursor: "next" },
};
function harness() {
  let index = 0;
  const slots: unknown[] = [];
  let tick = 0;
  const timers = new Map<number, () => void>();
  const effects: (() => void)[] = [];
  const requests: {
    channel: unknown;
    cursor: unknown;
    signal?: AbortSignal;
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  const api: ApiCall = async (_, params, options) =>
    new Promise((resolve, reject) => {
      requests.push({
        channel: params?.channel,
        cursor: params?.cursor,
        signal: options?.signal,
        resolve,
        reject,
      });
    });
  const react = {
    useState: (initial: unknown) => {
      const id = index++;
      if (!(id in slots)) slots[id] = initial;
      return [
        slots[id],
        (value: unknown) => {
          slots[id] = typeof value === "function" ? value(slots[id]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const id = index++;
      return slots[id] ?? (slots[id] = { current: initial });
    },
    useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
      const id = index++;
      const old = slots[id] as
        { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        old?.cleanup?.();
        slots[id] = { deps };
        effects.push(() => {
          (slots[id] as { cleanup?: () => void }).cleanup = fn();
        });
      }
    },
  };
  const exports: { useThreadContext: (...args: unknown[]) => ThreadDetail } =
    {} as never;
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/hub/use-thread-context.ts", "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    {
      exports,
      require: (id: string) => (id === "react" ? react : thread),
      AbortController,
      Date,
      setTimeout: (fn: () => void) => {
        const id = ++tick;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const identity = {
    teamId: "T1",
    userId: "U1",
    user: "me",
    team: "team",
    url: "https://example.test",
  };
  return {
    requests,
    api,
    advance: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
    },
    render: (
      selected: Hit | undefined = hit,
      opened = true,
      canFetch = true,
      client = api,
    ) => {
      index = 0;
      const value = exports.useThreadContext(
        {
          api: client,
          display: identity,
          fetchAs: canFetch ? identity : undefined,
          canFetch,
        },
        selected,
        opened,
      );
      while (effects.length) effects.shift()!();
      return value;
    },
    flush: () => new Promise(setImmediate),
  };
}

test("一覧だけ・未認証では取得せず、閉じるとabortし応答を採用しない", async () => {
  const ui = harness();
  ui.render(hit, false);
  ui.render(hit, true, false);
  assert.equal(ui.requests.length, 0);
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 1);
  ui.render(hit, false);
  assert.equal(ui.requests[0].signal?.aborted, true);
  ui.requests[0].resolve(complete);
  await ui.flush();
  assert.equal(ui.render(hit, false).data, undefined);
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 2);
});

test("選択変更直後に旧データを隠し、後着の旧応答を混ぜない", async () => {
  const ui = harness();
  ui.render();
  ui.advance();
  const other = { ...hit, key: "C2:3.000000", channelId: "C2" };
  assert.equal(ui.render(other).data, undefined);
  ui.advance();
  assert.equal(ui.requests[0].signal?.aborted, true);
  ui.requests[0].resolve(complete);
  await ui.flush();
  assert.equal(ui.render(other).data, undefined);
  ui.requests[1].resolve(complete);
  await ui.flush();
  const current = ui.render(other);
  assert.equal(current.data?.messages[0].channelId, "C2");
  assert.equal(current.loading, false);
});

test("追加取得は連打しても1回だけで、開き直しや別会話へ持ち越さない", async () => {
  const ui = harness();
  ui.render();
  ui.advance();
  ui.requests[0].resolve(partial);
  await ui.flush();
  const first = ui.render();
  first.more();
  first.more();
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].cursor, "next");
  ui.requests[1].resolve(complete);
  await ui.flush();
  assert.equal(ui.render().data?.messages.length, 2);
  ui.render(hit, false);
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.render().data?.messages.length, 2);
  ui.render({ ...hit, channelId: "C2" });
  ui.advance();
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests[2].cursor, undefined);
});

test("詳細更新はキャッシュを使わず、失敗しても取得済み本文を残す", async () => {
  const ui = harness();
  ui.render();
  ui.advance();
  ui.requests[0].resolve(complete);
  await ui.flush();
  const initial = ui.render();
  initial.refresh();
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 2);
  ui.requests[1].reject(
    new SlackApiError("api", "hidden", undefined, "missing_scope"),
  );
  await ui.flush();
  const failed = ui.render();
  assert.equal(failed.failure?.kind, "scope");
  assert.equal(failed.data?.messages.length, 2);
  assert.equal(failed.loading, false);
});

test("認証失効・別クライアントは即座に旧本文を隠す", async () => {
  const ui = harness();
  ui.render();
  ui.advance();
  ui.requests[0].resolve(complete);
  await ui.flush();
  assert.ok(ui.render().data);
  assert.equal(ui.render(hit, true, false).data, undefined);
  const other: ApiCall = (...args) => ui.api(...args);
  assert.equal(ui.render(hit, true, true, other).data, undefined);
  ui.advance();
  assert.equal(ui.requests.length, 2);
});

test("429の待機中に更新や追加取得を押しても通信しない", async () => {
  const ui = harness();
  ui.render();
  ui.advance();
  ui.requests[0].reject(new SlackApiError("rate_limited", "hidden", 60));
  await ui.flush();
  const paused = ui.render();
  assert.equal(paused.failure?.kind, "rate");
  paused.more();
  paused.refresh();
  ui.render();
  ui.advance();
  assert.equal(ui.requests.length, 1);
});

test("10回の素早い選択変更では最後の1件だけ取得する", () => {
  const ui = harness();
  for (let i = 0; i < 10; i++) ui.render({ ...hit, channelId: `C${i}` });
  assert.equal(ui.requests.length, 0);
  ui.advance();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].channel, "C9");
});
