import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as scanModule from "./message-scan.ts";
import * as gate from "./search-gate.ts";
import { scopeKey } from "../../slack/identity.ts";
import type { Hit } from "../../slack/hits.ts";
import type { MessageSearchPlan } from "../search-scope/search-plan.ts";
import type { MessageSearch } from "./use-message-search.ts";
function harness() {
  const slots: unknown[] = [];
  let index = 0;
  const effects: (() => void)[] = [];
  const queued: (() => void)[] = [];
  const requests: {
    query: string;
    signal: AbortSignal;
    resolve: (result: unknown) => void;
  }[] = [];
  const react = {
    useState: (initial: unknown) => {
      const id = index++;
      if (!(id in slots)) slots[id] = initial;
      return [
        slots[id],
        (next: unknown) => {
          slots[id] = typeof next === "function" ? next(slots[id]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const id = index++;
      return slots[id] ?? (slots[id] = { current: initial });
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => () => void, deps: unknown[]) => {
      const id = index++;
      const old = slots[id] as
        { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!old || deps.some((d, i) => d !== old.deps[i])) {
        old?.cleanup?.();
        slots[id] = { deps };
        effects.push(() => {
          (slots[id] as { cleanup?: () => void }).cleanup = fn();
        });
      }
    },
  };
  const api = () => {};
  const exports: { useMessageSearch?: (...args: unknown[]) => MessageSearch } =
    {};
  const deps: Record<string, unknown> = {
    react,
    "./gate-store.ts": {
      readAccountSearchPause: () => undefined,
      writeAccountSearchPause: (value: unknown) => value,
    },
    "./search-gate.ts": gate,
    "./message-scan.ts": scanModule,
    "../../slack/identity.ts": { scopeKey },
    "../../slack/slack.ts": {
      searchPage: (query: string, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          requests.push({ query, signal: options.signal, resolve });
        }),
    },
  };
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/search/use-message-search.ts", "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    {
      exports,
      require: (id: string) => deps[id],
      AbortController,
      Date,
      setTimeout: (fn: () => void) => {
        queued.push(fn);
        return queued.length;
      },
      clearTimeout: () => {},
    },
  );
  return {
    render: (fingerprint: string, canFetch = true) => {
      return render("same", fingerprint, canFetch);
    },
    renderExpression: (expression: string) => render(expression),
    flush: async () => {
      while (queued.length) queued.shift()!();
      await new Promise(setImmediate);
    },
    requests,
  };
  function render(expression: string, fingerprint?: string, canFetch = true) {
    index = 0;
    const plan: MessageSearchPlan | undefined = fingerprint
      ? {
          queries: [fingerprint],
          resolvedQuery: "same",
          conflicts: [],
          empty: false,
          canSearch: true,
          scope: { channelIds: "all", fingerprint },
        }
      : undefined;
    const state = exports.useMessageSearch!(
      expression,
      {
        display: { teamId: "T1", userId: "U1" },
        fetchAs: { userId: "U1" },
        api,
        canFetch,
      },
      plan,
    );
    while (effects.length) effects.shift()!();
    return state;
  }
}
const sample: Hit = {
  key: "C1:1.000000",
  channelId: "C1",
  ts: "1.000000",
  channelKind: "channel",
  text: "本文",
  permalink: "",
  mentionsSelf: false,
};
test("同expressionの範囲指紋変更で即時abortし、旧結果を画面へ反映しない", async () => {
  const ui = harness();
  ui.render("old");
  await ui.flush();
  assert.equal(ui.requests.length, 1);
  ui.render("new");
  assert.equal(ui.requests[0].signal.aborted, true);
  ui.requests[0].resolve({ kind: "ok", capped: false, hits: [sample] });
  await ui.flush();
  assert.equal(ui.render("new").hits.length, 0);
  ui.requests[1].resolve({ kind: "ok", capped: false, hits: [sample] });
  await new Promise(setImmediate);
  const state = ui.render("new");
  assert.equal(state.query, "same");
  assert.equal(state.hits.length, 1);
  assert.ok(state.progress);
});
test("認証未確定でcall0、取得後に認証が失効すると旧hitsを返さない", async () => {
  const ui = harness();
  ui.render("scope", false);
  await ui.flush();
  assert.equal(ui.requests.length, 0);
  ui.render("scope");
  await ui.flush();
  ui.requests[0].resolve({ kind: "ok", capped: false, hits: [sample] });
  await new Promise(setImmediate);
  assert.equal(ui.render("scope").hits.length, 1);
  assert.equal(ui.render("scope", false).hits.length, 0);
});

test("通常検索の一時失敗を同一入力で続行し、空欄から同じ入力へ戻ると新しい検索を始める", async () => {
  const ui = harness();
  ui.renderExpression("same");
  await ui.flush();
  ui.requests[0].resolve({
    kind: "failed",
    failure: { kind: "error", message: "一時失敗" },
  });
  await new Promise(setImmediate);
  const failed = ui.renderExpression("same");
  assert.equal(failed.progress?.calls, 1);
  assert.equal(failed.progress?.pendingCount, 1);
  failed.continueSearch();
  ui.renderExpression("same");
  await ui.flush();
  assert.equal(ui.requests.length, 2);
  ui.requests[1].resolve({ kind: "ok", capped: false, hits: [sample] });
  await new Promise(setImmediate);
  const completed = ui.renderExpression("same");
  assert.equal(completed.progress?.calls, 2);
  assert.equal(completed.progress?.pendingCount, 0);
  assert.equal(completed.hits.length, 1);

  ui.renderExpression("");
  await ui.flush();
  assert.equal(ui.renderExpression("").hits.length, 0);
  ui.renderExpression("same");
  await ui.flush();
  assert.equal(ui.requests.length, 3);
  ui.requests[2].resolve({ kind: "ok", capped: false, hits: [] });
  await new Promise(setImmediate);
  const fresh = ui.renderExpression("same");
  assert.equal(fresh.progress?.calls, 1);
  assert.equal(fresh.hits.length, 0);
});
