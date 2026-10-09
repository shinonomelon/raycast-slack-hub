import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getLastReads,
  listConversations,
  listPeople,
  listJoinedChannelIds,
  searchMessages,
  searchPage,
} from "./slack.ts";
import {
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiOptions,
  type ApiParams,
} from "./slack-api.ts";
function fake(respond: ApiCall) {
  const calls: {
    method: ApiMethod;
    params?: ApiParams;
    options?: ApiOptions;
  }[] = [];
  const api: ApiCall = async (method, params, options) => {
    calls.push({ method, params, options });
    return respond(method, params, options);
  };
  return { api, calls };
}
const SELF = "U1";
const NOW = 1_759_560_000_000;
const match = {
  ts: "1759560123.456789",
  text: "<@U1> 本文",
  user: "U2",
  channel: { id: "C1", name: "general" },
};
test("公開・非公開・グループDMをカーソルで全件取得し、種類を正規化する", async () => {
  const { api, calls } = fake(async (_method, p) =>
    p?.cursor
      ? {
          ok: true,
          channels: [
            { id: "G2", name: "mpdm-taro-jun-1", is_mpim: true },
            { id: "C3", is_archived: true },
          ],
          response_metadata: { next_cursor: "" },
        }
      : {
          ok: true,
          channels: [
            { id: "C1", name: "general", is_channel: true },
            { id: "G1", name: "private", is_private: true },
          ],
          response_metadata: { next_cursor: "next" },
        },
  );
  assert.deepEqual(await listConversations(api), [
    { id: "C1", name: "general", type: "public" },
    { id: "G1", name: "private", type: "private" },
    { id: "G2", name: "mpdm-taro-jun-1", type: "mpim" },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "conversations.list");
  assert.equal(calls[0].params?.limit, 200);
  assert.equal(calls[0].params?.exclude_archived, true);
  assert.equal(calls[1].params?.cursor, "next");
});
test("ユーザーはmembersから読み、削除済みを除外しボットは区別する", async () => {
  const { api, calls } = fake(async (_method, p) =>
    p?.cursor
      ? { ok: true, members: [{ id: "UBOT", name: "bot", is_bot: true }] }
      : {
          ok: true,
          members: [
            { id: "U1", name: "taro", profile: { display_name: "太郎" } },
            { id: "U2", name: "gone", deleted: true },
          ],
          response_metadata: { next_cursor: "next" },
        },
  );
  const people = await listPeople(api);
  assert.deepEqual(
    people.map((p) => [p.id, p.displayName, p.isBot]),
    [
      ["U1", "太郎", false],
      ["UBOT", "bot", true],
    ],
  );
  assert.equal(calls[0].method, "users.list");
});
test("参加中の一覧はusers.conversationsを使い、重複とアーカイブを除く", async () => {
  const { api, calls } = fake(async (_method, p) =>
    p?.cursor
      ? { ok: true, channels: [{ id: "C1" }, { id: "C2" }] }
      : {
          ok: true,
          channels: [{ id: "C1" }, { id: "C3", is_archived: true }],
          response_metadata: { next_cursor: "next" },
        },
  );
  assert.deepEqual(await listJoinedChannelIds(api), ["C1", "C2"]);
  assert.equal(calls[0].method, "users.conversations");
  assert.equal(calls[0].params?.types, "public_channel");
});
test("一覧の途中で失敗した時は部分結果を返さず、カーソル循環も止める", async () => {
  const partial = fake(async (_method, p) => {
    if (p?.cursor) throw new SlackApiError("rate_limited", "429", 45);
    return {
      ok: true,
      members: [{ id: "U1", name: "taro" }],
      response_metadata: { next_cursor: "next" },
    };
  });
  await assert.rejects(listPeople(partial.api), /429/);
  const cycle = fake(async () => ({
    ok: true,
    channels: [],
    response_metadata: { next_cursor: "same" },
  }));
  await assert.rejects(listConversations(cycle.api), /カーソル/);
  assert.equal(cycle.calls.length, 2);
});
test("名前のない会話を補完し、制御文字・不正なユーザーを画面へ渡さない", async () => {
  assert.deepEqual(
    await listConversations(async () => ({
      channels: [
        { id: "C1" },
        { id: "G1", name: "a\u0000b", is_private: true },
        { name: "no id" },
      ],
    })),
    [
      { id: "C1", name: "unnamed", type: "public" },
      { id: "G1", name: "ab", type: "private" },
    ],
  );
  assert.deepEqual(
    await listPeople(async () => ({ members: [null, { id: "U1" }] })),
    [],
  );
});
test("検索はmessages.matchesをHitへ変換し、自分のメンション・スレッドの親を維持する", async () => {
  const reply = {
    ...match,
    permalink:
      "https://example.slack.com/archives/C1/p1759560123456789?thread_ts=1759560100.000001",
  };
  const { api, calls } = fake(async () => ({
    ok: true,
    messages: { matches: [reply], total: 842 },
  }));
  const signal = new AbortController().signal;
  const result = await searchPage("請求 in:#general", {
    api,
    selfId: SELF,
    signal,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.capped, true);
  assert.equal(result.hits[0].mentionsSelf, true);
  assert.equal(result.hits[0].threadTs, "1759560100.000001");
  assert.deepEqual(calls[0].params, {
    query: "請求 in:#general",
    sort: "timestamp",
    sort_dir: "desc",
    count: 100,
    page: 1,
    highlight: false,
  });
  assert.equal(calls[0].options?.signal, signal);
  assert.equal(calls[0].options?.timeoutMs, 15_000);
});
test("総件数はtotalまたはpagination.total_countを読み、古い順も指定できる", async () => {
  const { api, calls } = fake(async () => ({
    ok: true,
    messages: { matches: [match], pagination: { total_count: 5 } },
  }));
  const result = await searchPage("請求", {
    api,
    selfId: SELF,
    sortDir: "asc",
  });
  assert.equal(result.kind === "ok" && result.capped, true);
  assert.equal(calls[0].params?.sort_dir, "asc");
  const exact = await searchPage("請求", {
    api: async () => ({ messages: { matches: [match], total: 1 } }),
    selfId: SELF,
  });
  assert.equal(exact.kind === "ok" && exact.capped, false);
});
test("空の検索結果と不正な検索応答を区別する", async () => {
  assert.deepEqual(
    await searchMessages("無し", {
      api: async () => ({ messages: { matches: [], total: 0 } }),
      selfId: SELF,
    }),
    { kind: "ok", hits: [] },
  );
  for (const data of [{}, { messages: {} }, { messages: { matches: "bad" } }])
    assert.equal(
      (await searchMessages("検索", { api: async () => data, selfId: SELF }))
        .kind,
      "failed",
    );
});
test("検索の中断は古い結果を捨て、429と時間切れは停止期限を返す", async () => {
  const controller = new AbortController();
  const api: ApiCall = async () => {
    controller.abort();
    return { messages: { matches: [match] } };
  };
  assert.deepEqual(
    await searchMessages("検索", {
      api,
      selfId: SELF,
      signal: controller.signal,
    }),
    { kind: "aborted" },
  );
  assert.deepEqual(
    await searchMessages("検索", {
      api: async () => {
        throw new SlackApiError("aborted", "abort");
      },
      selfId: SELF,
    }),
    { kind: "aborted" },
  );
  for (const error of [
    new SlackApiError("rate_limited", "429", 45),
    new SlackApiError("timeout", "timeout"),
  ]) {
    const result = await searchPage("検索", {
      api: async () => {
        throw error;
      },
      selfId: SELF,
      now: () => NOW,
    });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed")
      assert.equal(
        result.failure.pause?.until,
        NOW + (error.kind === "timeout" ? 30_000 : 45_000),
      );
  }
});
test("既読位置は最大20会話、重複除去してconversations.infoを呼ぶ", async () => {
  const { api, calls } = fake(async (_method, p) => ({
    ok: true,
    channel: { id: p?.channel, last_read: "1759560100.000001" },
  }));
  const ids = Array.from({ length: 25 }, (_, i) => `C${i}`);
  const result = await getLastReads(["--bad", "", "c1", "C0", ...ids], { api });
  assert.equal(result.kind, "ok");
  assert.equal(calls.length, 20);
  assert.equal(calls[0].method, "conversations.info");
  assert.equal(calls[0].options?.signal, undefined);
  if (result.kind === "ok")
    assert.equal(result.rows[0].lastRead, "1759560100.000001");
});
test("既読位置がない・見えない・壊れた会話は理由を返し、回数制限後は残りを呼ばない", async () => {
  const { api, calls } = fake(async (_method, p) => {
    const id = p?.channel;
    if (id === "C1") return { channel: { id } };
    if (id === "C2")
      throw new SlackApiError(
        "api",
        "channel_not_found",
        undefined,
        "channel_not_found",
      );
    if (id === "C3") return { channel: { id, last_read: "bad" } };
    throw new SlackApiError("rate_limited", "429", 45);
  });
  assert.deepEqual(
    await getLastReads(["C1", "C2", "C3", "C4", "C5"], { api }),
    {
      kind: "ok",
      rows: [
        { channelId: "C1", lastRead: null, reason: "no_last_read" },
        { channelId: "C2", lastRead: null, reason: "not_visible" },
        { channelId: "C3", lastRead: null, reason: "error" },
        {
          channelId: "C4",
          lastRead: null,
          reason: "rate_limited",
          retryAfter: 45,
        },
        {
          channelId: "C5",
          lastRead: null,
          reason: "rate_limited",
          retryAfter: 45,
        },
      ],
    },
  );
  assert.equal(calls.length, 4);
});
test("既読の認証失敗と時間切れは全体の失敗、会話IDの不一致は読取エラー", async () => {
  for (const error of [
    new SlackApiError("api", "invalid_auth", undefined, "invalid_auth"),
    new SlackApiError("timeout", "timeout"),
  ]) {
    const { api, calls } = fake(async () => {
      throw error;
    });
    const result = await getLastReads(["C1", "C2"], { api, now: () => NOW });
    assert.equal(result.kind, "failed");
    assert.equal(calls.length, 1);
  }
  const result = await getLastReads(["C1"], {
    api: async () => ({
      channel: { id: "C2", last_read: "1759560100.000001" },
    }),
  });
  assert.equal(result.kind === "ok" && result.rows[0].reason, "error");
});
test("取得対象がない時はAPIを呼ばない", async () => {
  const { api, calls } = fake(async () => ({}));
  assert.deepEqual(await getLastReads([], { api }), { kind: "ok", rows: [] });
  assert.equal(calls.length, 0);
});

test("ユーザーの不正なプロフィールは文字列に補完し、参加中の不正IDを除外する", async () => {
  const people = await listPeople(async () => ({
    members: [
      {
        id: "U1",
        name: "taro",
        real_name: 23,
        profile: { display_name: {}, real_name: 1, title: [] },
      },
      { id: "bad/id", name: "bad" },
      { id: "U2", name: " " },
    ],
  }));
  assert.deepEqual(people, [
    {
      id: "U1",
      handle: "taro",
      displayName: "taro",
      realName: "taro",
      title: "",
      isBot: false,
    },
  ]);
  assert.deepEqual(
    await listJoinedChannelIds(async () => ({
      channels: [{ id: "C1" }, { id: "bad/id" }],
    })),
    ["C1"],
  );
});
