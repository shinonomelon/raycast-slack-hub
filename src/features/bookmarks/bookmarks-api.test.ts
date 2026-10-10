import test from "node:test";
import assert from "node:assert/strict";
import {
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiParams,
} from "../../slack/slack-api.ts";
import { createWriteLock } from "../operations/write-outcome.ts";
import {
  addBookmark,
  editBookmark,
  fetchBookmarks,
  removeBookmark,
} from "./bookmarks-api.ts";
import { readBookmarks } from "./bookmarks-model.ts";

const raw = {
  id: "Bk123",
  channel_id: "C123",
  title: "資料",
  link: "https://example.com",
  type: "link",
  date_updated: 1,
};
const bookmark = readBookmarks({ ok: true, bookmarks: [raw] }, "C123")[0];
const input = { title: "更新後", link: "https://example.com/new" };
function fixture(
  options: {
    current?: unknown[];
    error?: SlackApiError;
    response?: Record<string, unknown>;
  } = {},
) {
  const calls: { method: ApiMethod; params?: ApiParams }[] = [];
  const api: ApiCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "bookmarks.list")
      return { ok: true, bookmarks: options.current ?? [raw] };
    if (options.error) throw options.error;
    return (
      options.response ??
      (method === "bookmarks.remove"
        ? { ok: true }
        : {
            ok: true,
            bookmark: { ...raw, title: input.title, link: input.link },
          })
    );
  };
  return { api, calls };
}
test("追加・編集・削除はチャンネルを固定し、1件だけのIDを送る", async () => {
  const added = fixture();
  assert.deepEqual(await addBookmark(added.api, "C123", input), {
    kind: "succeeded",
    id: "Bk123",
  });
  assert.deepEqual(
    added.calls.map(({ method }) => method),
    ["bookmarks.list", "bookmarks.add"],
  );
  assert.deepEqual(added.calls[1].params, {
    channel_id: "C123",
    type: "link",
    ...input,
  });
  const edited = fixture();
  assert.equal(
    (await editBookmark(edited.api, "C123", bookmark, input)).kind,
    "succeeded",
  );
  assert.deepEqual(edited.calls[1], {
    method: "bookmarks.edit",
    params: { channel_id: "C123", bookmark_id: "Bk123", ...input },
  });
  const removed = fixture();
  assert.equal(
    (await removeBookmark(removed.api, "C123", bookmark)).kind,
    "succeeded",
  );
  assert.deepEqual(removed.calls[1], {
    method: "bookmarks.remove",
    params: { channel_id: "C123", bookmark_id: "Bk123" },
  });
});
test("非link・別チャンネル・無効URL・空タイトルでは書き込みしない", async () => {
  for (const invalid of [
    { title: "", link: input.link },
    { ...input, link: "javascript:alert(1)" },
  ]) {
    const { api, calls } = fixture();
    assert.equal((await addBookmark(api, "C123", invalid)).kind, "failed");
    assert.equal(
      (await editBookmark(api, "C123", bookmark, invalid)).kind,
      "failed",
    );
    assert.equal(calls.length, 0);
  }
  for (const original of [
    { ...bookmark, type: "folder" },
    { ...bookmark, channelId: "C456" },
  ]) {
    const { api, calls } = fixture();
    assert.equal(
      (await editBookmark(api, "C123", original, input)).kind,
      "failed",
    );
    assert.equal((await removeBookmark(api, "C123", original)).kind, "failed");
    assert.equal(calls.length, 0);
  }
});
test("対象欠損・他者による変更・確認失敗で編集と削除を止める", async () => {
  for (const current of [
    [],
    [{ ...raw, title: "他者編集" }],
    [{ ...raw, link: "https://other.example" }],
    [{ ...raw, type: "folder" }],
    [{ ...raw, date_updated: 2 }],
  ]) {
    for (const action of [editBookmark, removeBookmark]) {
      const { api, calls } = fixture({ current });
      const outcome =
        action === editBookmark
          ? await editBookmark(api, "C123", bookmark, input)
          : await removeBookmark(api, "C123", bookmark);
      assert.equal(outcome.kind, "failed");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "bookmarks.list");
    }
  }
  for (const code of ["missing_scope", "invalid_auth", "channel_not_found"]) {
    let calls = 0;
    const api: ApiCall = async () => {
      calls++;
      throw new SlackApiError("api", code, undefined, code);
    };
    assert.equal((await addBookmark(api, "C123", input)).kind, "failed");
    assert.equal(calls, 1);
  }
});
test("事前確認中に認証や対象が変わった場合は書き込み0回", async () => {
  let current = true;
  const calls: ApiMethod[] = [];
  const api: ApiCall = async (method) => {
    calls.push(method);
    current = false;
    return { ok: true, bookmarks: [raw] };
  };
  assert.equal(
    (await addBookmark(api, "C123", input, () => current)).kind,
    "failed",
  );
  assert.deepEqual(calls, ["bookmarks.list"]);
  assert.equal(
    (await editBookmark(api, "C123", bookmark, input, () => false)).kind,
    "failed",
  );
  assert.equal(
    (await removeBookmark(api, "C123", bookmark, () => false)).kind,
    "failed",
  );
  assert.deepEqual(calls, ["bookmarks.list"]);
});
test("権限と対象エラーを成功に変えず、不明結果は再送しない", async () => {
  for (const code of [
    "no_permission",
    "permission_denied",
    "not_found",
    "invalid_auth",
  ]) {
    const { api, calls } = fixture({
      error: new SlackApiError("api", code, undefined, code),
    });
    assert.equal((await removeBookmark(api, "C123", bookmark)).kind, "failed");
    assert.equal(calls.length, 2);
  }
  for (const error of [
    new SlackApiError("timeout", "timeout"),
    new SlackApiError("network", "network"),
    new SlackApiError("api", "internal_error", undefined, "internal_error"),
  ]) {
    const { api, calls } = fixture({ error });
    const lock = createWriteLock();
    assert.equal(
      (await lock.run(() => addBookmark(api, "C123", input)))?.kind,
      "unconfirmed",
    );
    assert.equal(
      await lock.run(() => addBookmark(api, "C123", input)),
      undefined,
    );
    assert.equal(calls.length, 2);
  }
});
test("別対象の成功応答や壊れた応答は未確認とする", async () => {
  for (const response of [
    { ok: true },
    { ok: true, bookmark: { ...raw, channel_id: "C456" } },
    {
      ok: true,
      bookmark: { ...raw, title: input.title, link: input.link, id: "Bk456" },
    },
  ]) {
    const { api } = fixture({ response });
    assert.equal(
      (await editBookmark(api, "C123", bookmark, input)).kind,
      "unconfirmed",
    );
  }
});
test("読取にAbortSignalを渡し、不正なチャンネルIDでは通信しない", async () => {
  const abort = new AbortController();
  let calls = 0;
  const api: ApiCall = async (method, params, options) => {
    calls++;
    assert.equal(method, "bookmarks.list");
    assert.deepEqual(params, { channel_id: "C123" });
    assert.equal(options?.signal, abort.signal);
    return { ok: true, bookmarks: [raw] };
  };
  assert.equal((await fetchBookmarks(api, "C123", abort.signal)).length, 1);
  await assert.rejects(fetchBookmarks(api, "../evil"));
  assert.equal(calls, 1);
});
