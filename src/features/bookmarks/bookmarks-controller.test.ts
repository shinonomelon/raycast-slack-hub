import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../../slack/identity.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import {
  BookmarksController,
  type BookmarksState,
} from "./bookmarks-controller.ts";

const identity = {
  teamId: "T123",
  userId: "U123",
  user: "fixture",
  team: "fixture",
  url: "https://fixture.slack.com",
};
function session(api: ApiCall, userId = "U123", teamId = "T123"): Session {
  const display = { ...identity, userId, teamId };
  return { api, display, fetchAs: display, canFetch: true };
}
const response = (channelId: string, title: string) => ({
  ok: true,
  bookmarks: [
    {
      id: "Bk123",
      channel_id: channelId,
      title,
      link: "https://example.com",
      type: "link",
    },
  ],
});
function deferred() {
  let resolve!: (raw: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("別API・別アカウント・別対象へ切り替えた時、旧遅延結果を捨てる", async () => {
  for (const changed of ["api", "account", "team", "channel"] as const) {
    const slow = deferred();
    const states: BookmarksState[] = [];
    let count = 0;
    const api: ApiCall = async (_method, params) =>
      count++ === 0
        ? slow.promise
        : response(String(params?.channel_id), "新しい資料");
    const controller = new BookmarksController((state) => states.push(state));
    const old = controller.load(session(api), "C123");
    const nextApi: ApiCall =
      changed === "api" ? async () => response("C123", "新しい資料") : api;
    await controller.load(
      session(
        nextApi,
        changed === "account" ? "U456" : "U123",
        changed === "team" ? "T456" : "T123",
      ),
      changed === "channel" ? "C456" : "C123",
    );
    slow.resolve(response("C123", "古い資料"));
    assert.equal(await old, false);
    assert.equal(states.at(-1)?.data[0].title, "新しい資料");
    assert.equal(
      states.some((state) =>
        state.data.some((row) => row.title === "古い資料"),
      ),
      false,
    );
  }
});
test("認証未完了では通信せず既存結果を隠す", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return response("C123", "資料");
  };
  const states: BookmarksState[] = [];
  const controller = new BookmarksController((state) => states.push(state));
  await controller.load(session(api), "C123");
  const ready = session(api);
  await controller.load(
    { ...ready, canFetch: false, fetchAs: undefined },
    "C123",
  );
  assert.equal(calls, 1);
  assert.deepEqual(states.at(-1)?.data, []);
  assert.equal(states.at(-1)?.status, "auth-required");
});
test("保存後の失効で古い一覧を消し、再取得失敗は保存失敗にしない", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    if (calls++ > 0) throw new SlackApiError("network", "通信失敗");
    return response("C123", "資料");
  };
  const states: BookmarksState[] = [];
  const controller = new BookmarksController((state) => states.push(state));
  assert.equal(await controller.load(session(api), "C123"), true);
  controller.invalidate();
  assert.deepEqual(states.at(-1)?.data, []);
  assert.equal(await controller.load(session(api), "C123"), false);
  assert.equal(states.at(-1)?.status, "failed");
  assert.deepEqual(states.at(-1)?.data, []);
});
test("キャンセルと失効で読取をabortし、遅延応答を公開しない", async () => {
  for (const action of ["cancel", "invalidate"] as const) {
    const slow = deferred();
    let signal: AbortSignal | undefined;
    const states: BookmarksState[] = [];
    const controller = new BookmarksController((state) => states.push(state));
    const api: ApiCall = async (_method, _params, options) => {
      signal = options?.signal;
      return slow.promise;
    };
    const pending = controller.load(session(api), "C123");
    controller[action]();
    assert.equal(signal?.aborted, true);
    slow.resolve(response("C123", "古い資料"));
    assert.equal(await pending, false);
    assert.equal(
      states.some((state) => state.data.length > 0),
      false,
    );
  }
});
test("権限不足は機能内に必要なscopeとトークン更新を案内する", async () => {
  const states: BookmarksState[] = [];
  const controller = new BookmarksController((state) => states.push(state));
  const api: ApiCall = async () => {
    throw new SlackApiError("api", "missing_scope", undefined, "missing_scope");
  };
  await controller.load(session(api), "C123");
  assert.match(states.at(-1)?.message ?? "", /bookmarks:read/);
  assert.match(states.at(-1)?.message ?? "", /再インストール/);
});
