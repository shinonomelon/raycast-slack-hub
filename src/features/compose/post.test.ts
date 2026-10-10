import assert from "node:assert/strict";
import { test } from "node:test";
import { postMarkdown } from "./post.ts";
import { composeMarkdown, SEND_TIMEOUT_MS } from "./compose.ts";
import { toBlocks, toText } from "./md-to-blocks.ts";
import {
  createSlackApi,
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiOptions,
  type ApiParams,
} from "../../slack/slack-api.ts";
const TS = "1759560123.456789";
const params = {
  target: { kind: "conversation", id: "C1" } as const,
  mentionIds: ["U1"],
  markdown: "**確認**\n\n- 項目",
  teamId: "T1",
};
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
  return { calls, api };
}
test("本文とメンションをblocks/textに変換し、会話へ1回だけ投稿する", async () => {
  const { calls, api } = fake(async () => ({
    ok: true,
    channel: "C1",
    ts: TS,
  }));
  const result = await postMarkdown({ ...params, api });
  assert.equal(result.kind, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "chat.postMessage");
  const md = composeMarkdown(params.mentionIds, params.markdown);
  assert.deepEqual(calls[0].params, {
    channel: "C1",
    blocks: toBlocks(md),
    text: toText(md),
  });
  assert.ok((calls[0].options?.timeoutMs ?? 0) <= SEND_TIMEOUT_MS);
  assert.equal(calls[0].options?.signal, undefined);
});
test("人への投稿はconversations.openの返したDMへ送る。返信は親thread_tsへ送る", async () => {
  const { api, calls } = fake(async (method) =>
    method === "conversations.open"
      ? { ok: true, channel: { id: "D2" } }
      : { ok: true, channel: "D2", ts: TS },
  );
  const result = await postMarkdown({
    ...params,
    target: { kind: "person", id: "U2" },
    api,
  });
  assert.equal(result.kind, "sent");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["conversations.open", "chat.postMessage"],
  );
  assert.deepEqual(calls[0].params, { users: "U2" });
  assert.equal(calls[1].params?.channel, "D2");
  const reply = fake(async () => ({ ok: true, channel: "C1", ts: TS }));
  const replied = await postMarkdown({
    ...params,
    threadTs: "1759560100.000001",
    api: reply.api,
  });
  assert.equal(reply.calls[0].params?.thread_ts, "1759560100.000001");
  assert.equal(
    replied.kind === "sent" && replied.threadTs,
    "1759560100.000001",
  );
});
test("DMを開けない・応答が不正な場合は本文を送信しない", async () => {
  for (const respond of [
    async () => ({ ok: true, channel: { id: "C1" } }),
    async () => {
      throw new SlackApiError("timeout", "timeout");
    },
    async () => {
      throw new SlackApiError(
        "api",
        "missing_scope",
        undefined,
        "missing_scope",
      );
    },
  ]) {
    const { api, calls } = fake(respond);
    const result = await postMarkdown({
      ...params,
      target: { kind: "person", id: "U2" },
      api,
    });
    assert.equal(result.kind, "failed");
    assert.deepEqual(
      calls.map((c) => c.method),
      ["conversations.open"],
    );
  }
});
test("空本文・宛先・親tsが不正な場合はHTTP要求を送らない", async () => {
  const { api, calls } = fake(async () => ({ ok: true }));
  for (const value of [
    { ...params, markdown: " " },
    { ...params, target: { kind: "conversation", id: "--bad" } as const },
    { ...params, threadTs: "bad" },
  ])
    assert.equal((await postMarkdown({ ...value, api })).kind, "failed");
  assert.equal(calls.length, 0);
});
test("投稿の切断・HTTP失敗・時間切れ・読めない応答では送れたか未確認にし、自動再送しない", async () => {
  for (const error of [
    new SlackApiError("network", "network"),
    new SlackApiError("http", "500"),
    new SlackApiError("timeout", "timeout"),
    new SlackApiError("unreadable", "JSON"),
    new SlackApiError("api", "internal_error", undefined, "internal_error"),
  ]) {
    const { api, calls } = fake(async () => {
      throw error;
    });
    const result = await postMarkdown({ ...params, api });
    assert.equal(result.kind, "unconfirmed");
    assert.equal(calls.length, 1);
  }
  const { api } = fake(async () => ({ ok: true }));
  assert.equal((await postMarkdown({ ...params, api })).kind, "unconfirmed");
});
test("公式HTTP応答を通した投稿で、成功とAPI拒否を判定する", async () => {
  for (const ok of [true, false]) {
    let calls = 0;
    const api = createSlackApi("xoxp-test", async () => {
      calls++;
      return new Response(
        JSON.stringify(
          ok
            ? { ok, channel: "C1", ts: TS }
            : { ok, error: "channel_not_found" },
        ),
      );
    });
    const result = await postMarkdown({ ...params, api });
    assert.equal(result.kind, ok ? "sent" : "failed");
    assert.equal(calls, 1);
  }
});

test("長い段落・見出し・文字参照は上限内のsectionとして1回だけ送る", async () => {
  for (const markdown of [
    "あ".repeat(3001),
    "# " + "あ".repeat(3001),
    "&".repeat(601),
  ]) {
    const { api, calls } = fake(async () => ({
      ok: true,
      channel: "C1",
      ts: TS,
    }));
    assert.equal(
      (await postMarkdown({ ...params, mentionIds: [], markdown, api })).kind,
      "sent",
    );
    assert.equal(calls.length, 1);
    const blocks = calls[0].params?.blocks as {
      type: string;
      text: { text: string };
    }[];
    assert.ok(blocks.length > 1);
    assert.ok(
      blocks.every(
        (block) => block.type === "section" && block.text.text.length <= 3000,
      ),
    );
  }
});

test("50blocksを超える本文はDMを開く前に明確な非送信失敗を返す", async () => {
  for (const markdown of [
    Array(51).fill("段落").join("\n\n"),
    "a".repeat(150001),
  ]) {
    const { api, calls } = fake(async () => ({
      ok: true,
      channel: { id: "D2" },
      ts: TS,
    }));
    const result = await postMarkdown({
      ...params,
      mentionIds: [],
      target: { kind: "person", id: "U2" },
      markdown,
      api,
    });
    assert.equal(result.kind, "failed");
    assert.ok(
      result.kind === "failed" &&
        /50/.test(result.message) &&
        /送信していません/.test(result.message),
    );
    assert.equal(calls.length, 0);
  }
});

test("50blocksちょうどは送信し、前置きメンションで51になる場合は拒否する", async () => {
  const markdown = Array(50).fill("段落").join("\n\n");
  const { api, calls } = fake(async () => ({
    ok: true,
    channel: "C1",
    ts: TS,
  }));
  assert.equal(
    (await postMarkdown({ ...params, mentionIds: [], markdown, api })).kind,
    "sent",
  );
  assert.equal((calls[0].params?.blocks as unknown[]).length, 50);
  assert.equal(
    (await postMarkdown({ ...params, markdown, api })).kind,
    "failed",
  );
  assert.equal(calls.length, 1);
});

test("分割できない巨大リンクは本文を変更して送らず検証エラーを返す", async () => {
  const markdown = "[表示](https://example.com/" + "a".repeat(3000) + ")";
  const { api, calls } = fake(async () => ({ ok: true }));
  const result = await postMarkdown({ ...params, markdown, api });
  assert.equal(result.kind, "failed");
  assert.ok(
    result.kind === "failed" &&
      /3000/.test(result.message) &&
      /送信していません/.test(result.message),
  );
  assert.equal(calls.length, 0);
});
