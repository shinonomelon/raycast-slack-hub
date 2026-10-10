import test from "node:test";
import assert from "node:assert/strict";
import {
  bookmarkInput,
  bookmarkUrl,
  deleteBookmarkConfirmation,
  readBookmarks,
  sameBookmark,
} from "./bookmarks-model.ts";

const raw = {
  id: "Bk123",
  channel_id: "C123",
  title: "資料",
  type: "link",
  link: "https://example.com",
  date_updated: 123,
};
test("HTTP(S)だけを開き登録し、危険なスキームや認証入りURLを拒否する", () => {
  assert.equal(
    bookmarkUrl(" https://example.com/docs?a=1 "),
    "https://example.com/docs?a=1",
  );
  assert.equal(bookmarkUrl("http://example.com"), "http://example.com");
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/a",
    "data:text/html,x",
    "slack://channel",
    "https://user:secret@example.com",
    "https://example.com/a\nb",
    "https://example.com/a b",
    "",
    "https://",
  ])
    assert.equal(bookmarkUrl(value), undefined);
  assert.deepEqual(
    bookmarkInput({ title: " 資料 ", link: " https://example.com " }),
    { title: "資料", link: "https://example.com" },
  );
  assert.equal(
    bookmarkInput({ title: " ", link: "https://example.com" }),
    undefined,
  );
});
test("一覧は最大100件・対象チャンネルを検査し、不明型は閲覧モデルに残す", () => {
  assert.deepEqual(readBookmarks({ ok: true, bookmarks: [] }, "C123"), []);
  const rows = readBookmarks(
    {
      ok: true,
      bookmarks: [
        raw,
        raw,
        { ...raw, id: "Bk456", type: "folder", link: undefined },
      ],
    },
    "C123",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].type, "folder");
  for (const response of [
    { ok: true },
    { ok: false, bookmarks: [] },
    { ok: true, bookmarks: [{ ...raw, channel_id: "C456" }] },
    { ok: true, bookmarks: [null] },
    { ok: true, bookmarks: Array(101).fill(raw) },
  ])
    assert.throws(() => readBookmarks(response, "C123"));
});
test("タイトル・URL・型・対象・更新時刻の変更を検出する", () => {
  const bookmark = readBookmarks({ ok: true, bookmarks: [raw] }, "C123")[0];
  assert.equal(sameBookmark(bookmark, { ...bookmark }), true);
  for (const change of [
    { title: "別資料" },
    { link: "https://other.example" },
    { updatedAt: 124 },
    { type: "folder" },
    { channelId: "C456" },
    { id: "Bk456" },
  ])
    assert.equal(sameBookmark(bookmark, { ...bookmark, ...change }), false);
  const confirmation = deleteBookmarkConfirmation("fixture", bookmark);
  assert.match(confirmation, /#fixture/);
  assert.match(confirmation, /資料/);
  assert.match(confirmation, /https:\/\/example.com/);
});
