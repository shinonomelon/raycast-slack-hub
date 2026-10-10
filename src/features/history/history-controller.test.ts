import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import type { Session } from "../../slack/identity.ts";
import {
  SlackApiError,
  type ApiCall,
  type ApiParams,
} from "../../slack/slack-api.ts";
import { HistoryController, type HistoryState } from "./history-controller.ts";

const identity = {
  teamId: "T1",
  userId: "U1",
  user: "self",
  team: "team",
  url: "https://example.slack.com",
};
const session = (api: ApiCall, userId = "U1"): Session => ({
  canFetch: true,
  api,
  display: { ...identity, userId },
  fetchAs: { ...identity, userId },
});
const hit: Hit = {
  key: "C1:1791600000.000001",
  channelId: "C1",
  ts: "1791600000.000001",
  channelKind: "channel",
  text: "検索プレビュー",
  permalink: "",
  mentionsSelf: false,
};
const page = (timestamps: string[], cursor?: string) => ({
  ok: true,
  messages: timestamps.map((ts) => ({ ts, text: ts })),
  response_metadata: { next_cursor: cursor ?? "" },
});
const now = () => 1791602000000;
const parentTs = "1791599999.000001";
const replyPage = () => ({
  ok: true,
  messages: [{ ts: hit.ts, thread_ts: parentTs, text: "確認済み返信" }],
});
const parentPage = (cursor?: string, includeReply = true) => ({
  ok: true,
  messages: [
    { ts: parentTs, thread_ts: parentTs, text: "parent" },
    ...(includeReply
      ? [{ ts: hit.ts, thread_ts: parentTs, text: "現行返信" }]
      : []),
  ],
  response_metadata: { next_cursor: cursor ?? "" },
});

test("異常な候補は親要求を追加しない", async () => {
  for (const response of [
    { ...replyPage(), response_metadata: { next_cursor: "reply-cursor" } },
    { ok: true, messages: [{ ts: "1791600001.000001", thread_ts: parentTs }] },
    { ok: true, messages: [{ ts: hit.ts, thread_ts: "1791600001.000001" }] },
    {
      ok: true,
      messages: [
        { ts: hit.ts, thread_ts: parentTs },
        { ts: "1791600001.000001", thread_ts: parentTs },
      ],
    },
  ]) {
    let calls = 0;
    let state: HistoryState | undefined;
    const controller = new HistoryController((value) => {
      state = value;
    }, now);
    await controller.load(
      session(async () => {
        calls++;
        return response;
      }),
      hit,
      "thread",
    );
    assert.equal(calls, 1);
    assert.equal(state?.parentTs, undefined);
    assert.equal(state?.complete, false);
  }
});
test("親確認要求の直前にキャンセルした時は2回目を送らない", async () => {
  let calls = 0;
  const controller = new HistoryController((state) => {
    if (state.status === "loading" && state.messages.length)
      controller.cancel();
  }, now);
  await controller.load(
    session(async () => {
      calls++;
      return replyPage();
    }),
    hit,
    "thread",
  );
  assert.equal(calls, 1);
});

test("返信単件の親候補を親先頭の再取得で確認し、両要求のlimit/latestを固定する", async () => {
  const calls: { params: ApiParams; signal?: AbortSignal }[] = [];
  let state: HistoryState | undefined;
  const api: ApiCall = async (method, params = {}, options) => {
    assert.equal(method, "conversations.replies");
    calls.push({ params, signal: options?.signal });
    return calls.length === 1 ? replyPage() : parentPage();
  };
  const controller = new HistoryController((value) => {
    state = value;
  }, now);
  await controller.load(session(api), hit, "thread");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.ts, hit.ts);
  assert.equal(calls[1].params.ts, parentTs);
  assert.equal(calls[0].params.limit, 15);
  assert.equal(calls[1].params.latest, calls[0].params.latest);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(state?.parentTs, parentTs);
  assert.equal(state?.complete, true);
  assert.equal(state?.messages.length, 2);
  assert.equal(
    state?.messages.find((row) => row.ts === hit.ts)?.fullText,
    "現行返信",
  );
});
for (const knownParent of [true, false]) {
  test(`既知親または初回親応答には再取得しない known=${knownParent}`, async () => {
    let calls = 0;
    const api: ApiCall = async (_method, params) => {
      calls++;
      assert.equal(params?.ts, knownParent ? parentTs : hit.ts);
      return parentPage();
    };
    let state: HistoryState | undefined;
    const controller = new HistoryController((value) => {
      state = value;
    }, now);
    await controller.load(
      session(api),
      { ...hit, ...(knownParent ? { threadTs: parentTs } : {}) },
      "thread",
    );
    assert.equal(calls, 1);
    assert.equal(state?.parentTs, parentTs);
  });
}
for (const malformed of [
  "empty",
  "different-parent",
  "reply-only",
  "mixed-thread",
] as const) {
  test(`親確認の${malformed}は追跡を止めて初回本文を保持し返信禁止`, async () => {
    let calls = 0;
    let state: HistoryState | undefined;
    const api: ApiCall = async () => {
      if (++calls === 1) return replyPage();
      if (malformed === "empty") return page([]);
      if (malformed === "different-parent")
        return {
          ok: true,
          messages: [
            { ts: "1791599998.000001", thread_ts: "1791599998.000001" },
          ],
        };
      if (malformed === "reply-only") return replyPage();
      return {
        ok: true,
        messages: [
          { ts: parentTs, thread_ts: parentTs },
          { ts: hit.ts, thread_ts: "1791599998.000001" },
        ],
      };
    };
    const controller = new HistoryController((value) => {
      state = value;
    }, now);
    await controller.load(session(api), hit, "thread");
    assert.equal(calls, 2);
    assert.equal(state?.status, "failed");
    assert.equal(state?.parentTs, undefined);
    assert.equal(state?.complete, false);
    assert.equal(state?.cursor, undefined);
    assert.equal(state?.messages.length, 1);
    assert.equal(state?.messages[0].fullText, "確認済み返信");
    await controller.more();
    assert.equal(calls, 2);
  });
}
test("親確認ページのcursorを親tsで続け、選択返信が後ページでも欠損と表示しない", async () => {
  let calls = 0;
  let state: HistoryState | undefined;
  const api: ApiCall = async (_method, params) => {
    calls++;
    if (calls === 1) return replyPage();
    assert.equal(params?.ts, parentTs);
    if (calls === 2) return parentPage("parent-next", false);
    assert.equal(params?.cursor, "parent-next");
    return {
      ok: true,
      messages: [{ ts: hit.ts, thread_ts: parentTs, text: "next page reply" }],
    };
  };
  const controller = new HistoryController((value) => {
    state = value;
  }, now);
  await controller.load(session(api), hit, "thread");
  assert.equal(state?.parentTs, parentTs);
  assert.equal(state?.complete, false);
  assert.equal(state?.cursor, "parent-next");
  assert.equal(state?.error, undefined);
  assert.equal(state?.messages.length, 2);
  await controller.more();
  assert.equal(calls, 3);
  assert.equal(state?.complete, true);
  assert.equal(state?.messages.length, 2);
});
for (const kind of ["rate_limited", "timeout", "missing_scope"] as const) {
  test(`親確認${kind}は本文保持・完了なし・自動再送なし`, async () => {
    let calls = 0;
    let state: HistoryState | undefined;
    const api: ApiCall = async () => {
      if (++calls === 1) return replyPage();
      throw kind === "missing_scope"
        ? new SlackApiError("api", "scope", undefined, "missing_scope")
        : new SlackApiError(kind, "failure", 30);
    };
    const controller = new HistoryController((value) => {
      state = value;
    }, now);
    await controller.load(session(api), hit, "thread");
    assert.equal(calls, 2);
    assert.equal(state?.messages[0].fullText, "確認済み返信");
    assert.equal(state?.parentTs, undefined);
    assert.equal(state?.complete, false);
    await controller.more();
    assert.equal(calls, 2);
    if (kind === "rate_limited") {
      assert.equal(state?.retryAt, now() + 30000);
      await controller.retry();
      assert.equal(calls, 2);
    }
  });
}
for (const change of ["close", "api", "account", "target", "auth"] as const) {
  test(`親確認の遅延結果は表示しない ${change}`, async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    let started!: () => void;
    const secondStarted = new Promise<void>((done) => {
      started = done;
    });
    let calls = 0;
    const api: ApiCall = async () => {
      calls++;
      if (calls === 1) return replyPage();
      if (calls === 2)
        return new Promise((done) => {
          resolve = done;
          started();
        });
      return page([]);
    };
    const states: HistoryState[] = [];
    const controller = new HistoryController(
      (value) => states.push(value),
      now,
    );
    const pending = controller.load(session(api), hit, "thread");
    await secondStarted;
    if (change === "close") controller.cancel();
    else if (change === "auth")
      await controller.load(
        { canFetch: false, display: identity, fetchAs: undefined, api },
        hit,
        "thread",
      );
    else
      await controller.load(
        session(
          change === "api" ? async () => page([]) : api,
          change === "account" ? "U2" : "U1",
        ),
        change === "target" ? { ...hit, channelId: "C2" } : hit,
        "thread",
      );
    const length = states.length;
    resolve(parentPage());
    await pending;
    assert.equal(states.length, length);
    assert.equal(states.at(-1)?.parentTs, undefined);
  });
}
test("履歴はlimit15で1ページだけ。手動cursor後に隣接10分を取得する", async () => {
  const calls: ApiParams[] = [];
  const api: ApiCall = async (method, params = {}) => {
    assert.equal(method, "conversations.history");
    calls.push(params);
    return calls.length === 1
      ? page(["1791600002.000001"], "next")
      : page(["1791600001.000001"]);
  };
  const states: HistoryState[] = [];
  const controller = new HistoryController((state) => states.push(state), now);
  await controller.load(session(api), hit, "history");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 15);
  assert.equal(calls[0].oldest, "1791599400.000000");
  assert.equal(calls[0].latest, "1791600600.000000");
  assert.equal(states.at(-1)?.complete, false);
  await controller.extend("earlier");
  assert.equal(calls.length, 1);
  await controller.more();
  assert.equal(calls[1].cursor, "next");
  assert.deepEqual(
    states.at(-1)?.messages.map((row) => row.ts),
    ["1791600001.000001", "1791600002.000001"],
  );
  await controller.extend("earlier");
  assert.equal(calls[2].oldest, "1791598800.000000");
  assert.equal(calls[2].latest, "1791599400.000000");
  assert.equal(calls[2].cursor, undefined);
  await controller.extend("later");
  assert.equal(calls[3].oldest, "1791600600.000000");
  assert.equal(calls[3].latest, "1791601200.000000");
});
test("historyに選択返信がなくても0件を削除とせず、親解決はrepliesの先頭で判断", async () => {
  const states: HistoryState[] = [];
  const parentTs = "1791599999.000001";
  const api: ApiCall = async (method) =>
    method === "conversations.history"
      ? page([])
      : {
          ok: true,
          messages: [
            { ts: parentTs, thread_ts: parentTs, text: "parent" },
            { ts: hit.ts, thread_ts: parentTs, text: "reply" },
          ],
        };
  const controller = new HistoryController((state) => states.push(state), now);
  await controller.load(
    session(api),
    { ...hit, threadTs: parentTs },
    "history",
  );
  assert.equal(states.at(-1)?.status, "ready");
  assert.equal(states.at(-1)?.error, undefined);
  await controller.load(session(api), { ...hit, threadTs: parentTs }, "thread");
  assert.equal(states.at(-1)?.parentTs, parentTs);
  assert.equal(states.at(-1)?.messages.length, 2);
});
test("返信tsで親が返らなければ返信先を推測せず禁止する", async () => {
  let state: HistoryState | undefined;
  const api: ApiCall = async () => ({
    ok: true,
    messages: [{ ts: hit.ts, thread_ts: "1791599999.000001" }],
  });
  const controller = new HistoryController((value) => {
    state = value;
  }, now);
  await controller.load(session(api), hit, "thread");
  assert.equal(state?.parentTs, undefined);
  assert.match(state?.error ?? "", /親メッセージ/);
});
test("429は取得済みを残しRetry-Afterまで追加送信0回。missing_scopeも該当画面に表示", async () => {
  let count = 0;
  let clock = now();
  let state: HistoryState | undefined;
  const api: ApiCall = async () => {
    if (++count === 1) return page([hit.ts], "next");
    throw new SlackApiError("rate_limited", "limit", 30);
  };
  const controller = new HistoryController(
    (value) => {
      state = value;
    },
    () => clock,
  );
  await controller.load(session(api), hit, "history");
  await controller.more();
  assert.equal(state?.messages.length, 1);
  assert.equal(state?.retryAt, clock + 30000);
  await controller.more();
  await controller.retry();
  assert.equal(count, 2);
  clock += 30000;
  await controller.retry();
  assert.equal(count, 3);
  await controller.load(
    session(async () => {
      throw new SlackApiError("api", "scope", undefined, "missing_scope");
    }),
    hit,
    "history",
  );
  assert.match(state?.error ?? "", /history scope/);
});
test("繰り返しcursorと容量上限では追加取得しない", async () => {
  let count = 0;
  let state: HistoryState | undefined;
  const controller = new HistoryController((value) => {
    state = value;
  }, now);
  const api: ApiCall = async () => {
    count++;
    return page([hit.ts], "loop");
  };
  await controller.load(session(api), hit, "history");
  await controller.more();
  assert.equal(state?.status, "failed");
  assert.equal(state?.messages.length, 1);
  const large: ApiCall = async () => {
    count++;
    return {
      ok: true,
      messages: [{ ts: hit.ts, text: "あ".repeat(700000) }],
      response_metadata: { next_cursor: "next" },
    };
  };
  await controller.load(session(large), hit, "history");
  assert.equal(state?.capped, true);
  await controller.more();
  await controller.extend("earlier");
  assert.equal(count, 3);
});
for (const change of ["target", "api", "account", "auth", "close"] as const) {
  test(`遅延応答を表示しない ${change}`, async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    let calls = 0;
    const api: ApiCall = async () =>
      ++calls === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : page([]);
    const states: HistoryState[] = [];
    const controller = new HistoryController(
      (value) => states.push(value),
      now,
    );
    const pending = controller.load(session(api), hit, "history");
    const firstResolve = resolve;
    const freshApi: ApiCall = async () => page([]);
    if (change === "close") controller.cancel();
    else if (change === "auth")
      await controller.load(
        { canFetch: false, api, display: identity, fetchAs: undefined },
        hit,
        "history",
      );
    else {
      const newSession =
        change === "account"
          ? session(api, "U2")
          : session(change === "api" ? freshApi : api);
      await controller.load(
        newSession,
        change === "target" ? { ...hit, channelId: "C2" } : hit,
        "history",
      );
    }
    const length = states.length;
    firstResolve(page([hit.ts]));
    await pending;
    assert.equal(states.length, length);
    assert.equal(states.at(-1)?.messages.length, 0);
  });
}
