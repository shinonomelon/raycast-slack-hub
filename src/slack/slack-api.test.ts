import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackApi, SlackApiError, type ApiMethod } from "./slack-api.ts";
import { apiForToken } from "./slack-api-runner.ts";
const TOKEN = "xoxp-test-token";
const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers });
const isKind = (kind: string) => (error: unknown) =>
  error instanceof SlackApiError && error.kind === kind;

test("GETは公式URLとBearerヘッダーを使い、検索語をURLエンコードする", async () => {
  const api = createSlackApi(TOKEN, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://slack.com");
    assert.equal(url.pathname, "/api/search.messages");
    assert.equal(url.searchParams.get("query"), "請求書 in:#会話 & リンク");
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${TOKEN}`,
    );
    return json({ ok: true, messages: { matches: [] } });
  });
  await api("search.messages", { query: "請求書 in:#会話 & リンク" });
});
test("POSTはJSONのblocks/text/thread_tsを変更せずに渡す", async () => {
  const payload = {
    channel: "C1",
    text: "通知用",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "*本文*" } }],
    thread_ts: "1759560123.000001",
  };
  const api = createSlackApi(TOKEN, async (input, init) => {
    assert.equal(String(input), "https://slack.com/api/chat.postMessage");
    assert.equal(init?.method, "POST");
    assert.match(
      new Headers(init?.headers).get("Content-Type") ?? "",
      /application\/json/,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    return json({ ok: true, channel: "C1", ts: "1759560124.000001" });
  });
  await api("chat.postMessage", payload);
});
test("HTTPメソッドはauth.testとconversations.openがPOST、それ以外の読取はGET", async () => {
  for (const method of [
    "auth.test",
    "conversations.open",
    "conversations.list",
    "users.list",
    "users.conversations",
    "conversations.info",
  ] as ApiMethod[]) {
    const api = createSlackApi(TOKEN, async (_input, init) => {
      assert.equal(
        init?.method,
        ["auth.test", "conversations.open"].includes(method) ? "POST" : "GET",
      );
      return json({ ok: true });
    });
    await api(method);
  }
});
test("追加した読取POSTと書込はJSONを送り、履歴・反応取得・検索はGETになる", async () => {
  const posts: ApiMethod[] = [
    "bookmarks.list",
    "bookmarks.add",
    "bookmarks.edit",
    "bookmarks.remove",
    "reactions.add",
    "reactions.remove",
    "slackLists.items.list",
    "slackLists.items.info",
    "slackLists.items.create",
    "slackLists.items.update",
    "slackLists.items.delete",
  ];
  const gets: ApiMethod[] = [
    "conversations.history",
    "conversations.replies",
    "reactions.get",
    "search.files",
    "chat.getPermalink",
  ];
  const params = {
    list_id: "F123",
    cells: [{ row_id: "R123", column_id: "Col123", user: ["U123"] }],
  };
  for (const method of [...posts, ...gets]) {
    const api = createSlackApi(TOKEN, async (url, init) => {
      assert.equal(new URL(String(url)).pathname, `/api/${method}`);
      assert.equal(init?.method, posts.includes(method) ? "POST" : "GET");
      if (posts.includes(method)) {
        assert.deepEqual(JSON.parse(String(init?.body)), params);
        assert.equal(new URL(String(url)).search, "");
      } else {
        assert.equal(init?.body, undefined);
      }
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
      return json({ ok: true });
    });
    await api(method, params);
  }
});
test("Bot・空トークンはHTTP要求を送る前に拒否する", async () => {
  for (const token of ["", "xoxb-bot", "xapp-app", "invalid"]) {
    let calls = 0;
    const api = createSlackApi(token, async () => {
      calls++;
      return json({ ok: true });
    });
    await assert.rejects(api("auth.test"), isKind("configuration"));
    assert.equal(calls, 0);
  }
});
test("ok:falseはAPIエラー、ok欠落・不正JSONは読取エラーになる", async () => {
  const api = createSlackApi(TOKEN, async () =>
    json({ ok: false, error: "missing_scope", needed: "channels:read" }),
  );
  await assert.rejects(
    api("users.list"),
    (error: unknown) =>
      error instanceof SlackApiError &&
      error.code === "missing_scope" &&
      error.message.includes("channels:read"),
  );
  for (const response of [
    json({}),
    json(null),
    new Response("broken"),
    json([]),
  ]) {
    await assert.rejects(
      createSlackApi(TOKEN, async () => response)("auth.test"),
      isKind("unreadable"),
    );
  }
});
test("429はRetry-Afterを保持して同じメソッドの再要求を止め、別メソッドは止めない", async () => {
  const calls: string[] = [];
  const api = createSlackApi(TOKEN, async (url) => {
    calls.push(String(url));
    return calls.length === 1
      ? json({}, 429, { "Retry-After": "45" })
      : json({ ok: true });
  });
  await assert.rejects(
    api("search.messages"),
    (e: unknown) => e instanceof SlackApiError && e.retryAfter === 45,
  );
  await assert.rejects(api("search.messages"), isKind("rate_limited"));
  assert.equal(calls.length, 1);
  await api("auth.test");
  assert.equal(calls.length, 2);
});
test("Retry-Afterが欠落・不正・ゼロなら60秒止める", async () => {
  for (const value of [undefined, "bad", "0", "-1"]) {
    const api = createSlackApi(TOKEN, async () =>
      json({}, 429, value ? { "Retry-After": value } : {}),
    );
    await assert.rejects(
      api("auth.test"),
      (e: unknown) => e instanceof SlackApiError && e.retryAfter === 60,
    );
  }
});
test("送信のHTTP失敗と通信切断は自動再試行せず、秘密を例外へ出さない", async () => {
  for (const http of [true, false]) {
    let calls = 0;
    const api = createSlackApi(TOKEN, async () => {
      calls++;
      if (http) return new Response(TOKEN, { status: 503 });
      throw new Error(`Bearer ${TOKEN} 本文の秘密`);
    });
    await assert.rejects(
      api("chat.postMessage"),
      (e: unknown) =>
        e instanceof SlackApiError &&
        e.kind === (http ? "http" : "network") &&
        !e.message.includes(TOKEN) &&
        !e.message.includes("本文の秘密"),
    );
    assert.equal(calls, 1);
  }
});
test("APIのエラー本文にトークンが混ざっていても表示しない", async () => {
  const api = createSlackApi(TOKEN, async () =>
    json({ ok: false, error: TOKEN, needed: TOKEN, message: TOKEN }),
  );
  await assert.rejects(
    api("auth.test"),
    (e: unknown) => e instanceof SlackApiError && !e.message.includes(TOKEN),
  );
});
const waiting: typeof fetch = async (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", () => reject(new Error("abort")), {
      once: true,
    });
  });
test("時間切れはHTTP要求を中断し、呼び出し元の中断とは区別する", async () => {
  const api = createSlackApi(TOKEN, waiting);
  await assert.rejects(
    api("search.messages", {}, { timeoutMs: 5 }),
    isKind("timeout"),
  );
  const controller = new AbortController();
  const running = api("search.messages", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, isKind("aborted"));
});
test("中断済みの検索はHTTP要求を送らない", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const api = createSlackApi(TOKEN, async () => {
    calls++;
    return json({ ok: true });
  });
  await assert.rejects(
    api("search.messages", {}, { signal: controller.signal }),
    isKind("aborted"),
  );
  assert.equal(calls, 0);
});
test("トークン別のクライアントを共有し、後から作った別アカウントに既存クライアントを切り替えない", async () => {
  assert.equal(apiForToken(TOKEN), apiForToken(` ${TOKEN} `));
  assert.notEqual(apiForToken(TOKEN), apiForToken("xoxp-other"));
  const headers: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers).get("Authorization")!);
    return json({ ok: true });
  };
  const first = createSlackApi(TOKEN, fetcher);
  const second = createSlackApi("xoxp-other", fetcher);
  await first("auth.test");
  await second("auth.test");
  await first("users.list");
  assert.deepEqual(headers, [
    `Bearer ${TOKEN}`,
    "Bearer xoxp-other",
    `Bearer ${TOKEN}`,
  ]);
});
