import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchPersonChannels,
  fetchChannelMembers,
  type MembershipRequest,
} from "./membership-api.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
const request = (): MembershipRequest => ({
  signal: new AbortController().signal,
  deadline: 30000,
  now: () => 0,
});
test("空ページもcursorがあれば続け、全ページのIDを重複なく取得", async () => {
  let count = 0;
  const api: ApiCall = async (method, params, options) => {
    assert.equal(method, "conversations.members");
    assert.equal(params?.limit, 200);
    assert.equal(params?.channel, "C1");
    assert.equal(options?.timeoutMs, 30000);
    count++;
    return {
      ok: true,
      members: count === 1 ? ["U1"] : count === 2 ? [] : ["U1", "U2"],
      response_metadata: { next_cursor: count < 3 ? `page${count}` : "" },
    };
  };
  assert.deepEqual(await fetchChannelMembers(api, "C1", request()), [
    "U1",
    "U2",
  ]);
  assert.equal(count, 3);
});
test("公開・非公開だけを正規化しアーカイブとDMを除く", async () => {
  const api: ApiCall = async (_method, params) => {
    assert.equal(params?.user, "U1");
    assert.equal(params?.types, "public_channel,private_channel");
    assert.equal(params?.exclude_archived, true);
    return {
      ok: true,
      channels: [
        { id: "C1", name: "public" },
        { id: "G1", name: "private", is_private: true },
        { id: "C2", is_archived: true },
        { id: "G2", is_mpim: true },
      ],
    };
  };
  assert.deepEqual(await fetchPersonChannels(api, "U1", request()), [
    { id: "C1", name: "public", type: "public" },
    { id: "G1", name: "private", type: "private" },
  ]);
});
for (const data of [
  { ok: true },
  { ok: true, members: ["bad"] },
  { ok: true, members: [], response_metadata: [] },
  { ok: true, members: [], response_metadata: { next_cursor: 123 } },
  { ok: false, members: [] },
]) {
  test(`不正応答を完成扱いしない ${JSON.stringify(data)}`, async () => {
    await assert.rejects(
      fetchChannelMembers(async () => data, "C1", request()),
      (error: unknown) =>
        error instanceof SlackApiError && error.kind === "unreadable",
    );
  });
}
test("循環cursorを拒否する", async () => {
  let calls = 0;
  await assert.rejects(
    fetchChannelMembers(
      async () => {
        calls++;
        return {
          ok: true,
          members: ["U1"],
          response_metadata: { next_cursor: "again" },
        };
      },
      "C1",
      request(),
    ),
  );
  assert.equal(calls, 2);
});
test("2ページ目が失敗したら部分結果を返さない", async () => {
  let calls = 0;
  await assert.rejects(
    fetchChannelMembers(
      async () => {
        if (++calls === 2) throw new SlackApiError("network", "failure");
        return {
          ok: true,
          members: ["U1"],
          response_metadata: { next_cursor: "next" },
        };
      },
      "C1",
      request(),
    ),
  );
});
test("取消後にAPIが遅延成功しても破棄する", async () => {
  const controller = new AbortController();
  const req = { ...request(), signal: controller.signal };
  await assert.rejects(
    fetchChannelMembers(
      async () => {
        controller.abort();
        return { ok: true, members: [] };
      },
      "C1",
      req,
    ),
    (error: unknown) =>
      error instanceof SlackApiError && error.kind === "aborted",
  );
});
test("残り時間を次ページへ渡し30秒を越えたら失敗する", async () => {
  let now = 0;
  const times: number[] = [];
  await assert.rejects(
    fetchChannelMembers(
      async (_method, _params, options) => {
        times.push(options!.timeoutMs!);
        now += 20000;
        return {
          ok: true,
          members: [],
          response_metadata: { next_cursor: String(now) },
        };
      },
      "C1",
      { ...request(), now: () => now },
    ),
    (error: unknown) =>
      error instanceof SlackApiError && error.kind === "timeout",
  );
  assert.deepEqual(times, [30000, 10000]);
});
