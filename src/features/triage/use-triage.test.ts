import * as i18n from "../../shared/i18n.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as gate from "../search/search-gate.ts";
import * as triageFetch from "./triage-fetch.ts";
import * as triage from "./triage.ts";
import * as unreadTags from "./unread-tags.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import type { ApiCall } from "../../slack/slack-api.ts";

// 本物の取得器と停止ストアをつなぎ、画面の再作成とAPIクライアントの交代を再現する。
function harness(cause: gate.Pause["cause"] = "rate_limited") {
  let now = Date.now();
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const entries = new Map<string, string>();
  class Cache {
    get(key: string) {
      return entries.get(key);
    }
    set(key: string, value: string) {
      entries.set(key, value);
    }
  }
  const gateStore: {
    readPause?: (kind: gate.GateKind, now?: number) => gate.Pause | undefined;
    writePause?: (kind: gate.GateKind, pause: gate.Pause) => gate.Pause;
    readAccountSearchPause?: (
      account: string,
      now?: number,
    ) => gate.Pause | undefined;
    writeAccountSearchPause?: (
      account: string,
      pause: gate.Pause,
    ) => gate.Pause;
  } = {};
  function evaluate(
    path: string,
    exports: unknown,
    deps: Record<string, unknown>,
  ) {
    runInNewContext(
      ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText,
      {
        exports,
        require: (id: string) => {
          if (id.endsWith("/i18n.ts")) return i18n;
          assert.ok(id in deps, id);
          return deps[id];
        },
        Date: FakeDate,
        Map,
        Set,
        WeakMap,
      },
    );
  }
  evaluate("src/features/search/gate-store.ts", gateStore, {
    "@raycast/api": { Cache },
    "./search-gate.ts": gate,
  });
  const effects: (() => unknown)[] = [];
  const searches: { api: ApiCall; selfId: string }[] = [];
  const lastReads: { api: ApiCall; ids: readonly string[] }[] = [];
  let limited = true;
  const toasts: { title: string }[] = [];
  const store = {
    loadTriage: () => undefined,
    saveTriage: () => {},
    loadFavoriteHits: () => undefined,
    saveFavoriteHits: () => {},
    loadLastReads: () => new Map(),
    lastReadForgottenAt: () => undefined,
    saveLastReads: () => {},
    loadUnknownChecks: () => ({}),
    saveUnknownCheck: () => {},
    loadOpened: () => ({}),
    loadMarks: () => new Set(),
  };
  const exports: {
    useTriage?: (params: {
      favoriteIds: string[];
      session: Session;
    }) => unknown;
  } = {};
  evaluate("src/features/triage/use-triage.ts", exports, {
    react: {
      useState: (initial: unknown) => [
        typeof initial === "function" ? initial() : initial,
        () => {},
      ],
      useRef: (initial: unknown) => ({ current: initial }),
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
      useEffect: (fn: () => unknown) => effects.push(fn),
    },
    "@raycast/api": {
      showToast: (value: { title: string }) => {
        toasts.push(value);
        return Promise.resolve();
      },
      Toast: { Style: { Failure: "failure" } },
    },
    "../search/gate-store.ts": gateStore,
    "../../slack/request-context.ts": {
      getApiCredentialKey: () => undefined,
      recordRequestCacheHit: () => {},
    },
    "../../slack/identity.ts": { scopeKey },
    "./read-state.ts": { readStateOf: () => store },
    "./triage-fetch.ts": triageFetch,
    "./triage.ts": triage,
    "./unread-tags.ts": unreadTags,
    "../../slack/slack.ts": {
      searchPage: (
        _query: string,
        options: { api: ApiCall; selfId: string },
      ) => {
        searches.push(options);
        return Promise.resolve(
          limited
            ? {
                kind: "failed",
                failure: {
                  kind: cause,
                  message: "429",
                  pause: { until: now + 60_000, cause },
                },
              }
            : { kind: "ok", hits: [], capped: false },
        );
      },
      getLastReads: (ids: readonly string[], options: { api: ApiCall }) => {
        lastReads.push({ ...options, ids });
        return Promise.resolve({ kind: "ok", rows: [] });
      },
    },
  });
  return {
    mount: async (account: string, api: ApiCall) => {
      const [teamId, userId] = account.split("-");
      const identity = { teamId, userId, team: "test", user: "test", url: "" };
      exports.useTriage!({
        favoriteIds: ["C1"],
        session: { canFetch: true, display: identity, fetchAs: identity, api },
      });
      while (effects.length) effects.shift()!();
      await new Promise(setImmediate);
    },
    setLimited: (value: boolean) => {
      limited = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    gateStore,
    toasts,
    searches,
    lastReads,
  };
}

test("アカウント別ストアの検索停止中は、APIクライアントを交代しても自分宛て検索を呼ばない", async () => {
  const ui = harness();
  ui.setLimited(false);
  ui.gateStore.writeAccountSearchPause!("T1-U1", {
    until: Date.now() + 300_000,
    cause: "rate_limited",
  });
  await ui.mount("T1-U1", () => Promise.resolve({}));
  await ui.mount("T1-U1", () => Promise.resolve({}));
  assert.equal(ui.searches.length, 0);
  assert.equal(ui.lastReads.length, 2);
});

test("自分宛て検索の429停止はAPIクライアント交代後も期限内は継続し、別アカウントと既読位置を止めない", async () => {
  const ui = harness();
  const api = () => Promise.resolve({});
  await ui.mount("T1-U1", api);
  assert.ok(ui.searches.length >= 2);
  const firstCalls = ui.searches.length;
  assert.equal(
    ui.gateStore.readAccountSearchPause!("T1-U1")?.cause,
    "rate_limited",
  );
  assert.equal(ui.gateStore.readPause!("search"), undefined);
  assert.equal(ui.gateStore.readPause!("last-read"), undefined);

  ui.setLimited(false);
  await ui.mount("T1-U1", () => Promise.resolve({}));
  assert.equal(ui.searches.length, firstCalls);
  assert.equal(ui.lastReads.length, 2);
  await ui.mount("T1-U2", () => Promise.resolve({}));
  assert.ok(ui.searches.length > firstCalls);
  assert.ok(ui.searches.some((call) => call.selfId === "U2"));

  const beforeExpiry = ui.searches.length;
  ui.advance(60_000);
  await ui.mount("T1-U1", () => Promise.resolve({}));
  assert.ok(ui.searches.length > beforeExpiry);
});

test("既存last-read停止を維持し、アカウント別検索停止と互いに混同しない", async () => {
  const ui = harness();
  ui.setLimited(false);
  const until = Date.now() + 300_000;
  ui.gateStore.writePause!("last-read", { until, cause: "timeout" });
  await ui.mount("T1-U1", () => Promise.resolve({}));
  assert.ok(ui.searches.length >= 2);
  assert.equal(ui.lastReads.length, 0);
  assert.equal(ui.gateStore.readPause!("last-read")?.until, until);
  assert.equal(ui.gateStore.readAccountSearchPause!("T1-U1"), undefined);
});

for (const language of ["ja", "en"] as const) {
  test(`未送信の延期は回数制限や時間切れと区別して表示する ${language}`, async () => {
    i18n.setLanguage(language);
    try {
      const ui = harness("deferred");
      await ui.mount("T1-U1", () => Promise.resolve({}));
      assert.ok(
        ui.toasts.some(
          (toast) => toast.title === i18n.t("Slack APIの取得を延期しました"),
        ),
      );
      assert.ok(
        ui.toasts.every(
          (toast) =>
            !/時間切れ|回数制限|timed out|rate limit/i.test(toast.title),
        ),
      );
    } finally {
      i18n.setLanguage("ja");
    }
  });
}
