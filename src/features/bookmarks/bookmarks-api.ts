import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import { runWrite, type WriteOutcome } from "../operations/write-outcome.ts";
import {
  bookmarkInput,
  readBookmark,
  readBookmarks,
  sameBookmark,
  validChannelId,
  type Bookmark,
  type BookmarkInput,
} from "./bookmarks-model.ts";

export async function fetchBookmarks(
  api: ApiCall,
  channelId: string,
  signal?: AbortSignal,
): Promise<Bookmark[]> {
  if (!validChannelId(channelId))
    throw new SlackApiError("configuration", "チャンネルIDを確認できません");
  return readBookmarks(
    await api("bookmarks.list", { channel_id: channelId }, { signal }),
    channelId,
  );
}
const failed = (message: string): WriteOutcome => ({ kind: "failed", message });
const preflightError = (error: unknown): WriteOutcome =>
  failed(
    error instanceof SlackApiError
      ? `送信前の対象確認に失敗しました: ${error.message}`
      : "送信前の対象確認に失敗しました",
  );

// 編集と削除は開始時の資料と直前の資料が一致するときだけ送る。失敗した読取は書込失敗とは区別する。
async function checkTarget(
  api: ApiCall,
  channelId: string,
  original?: Bookmark,
): Promise<WriteOutcome | undefined> {
  if (
    !validChannelId(channelId) ||
    (original && (original.channelId !== channelId || original.type !== "link"))
  ) {
    return failed("この対象は編集できません");
  }
  try {
    const current = await fetchBookmarks(api, channelId);
    if (original) {
      const found = current.find((bookmark) => bookmark.id === original.id);
      if (!found || !sameBookmark(original, found))
        return failed(
          "資料が変更されたか見つかりません。一覧を再読込し、対象を確認してください",
        );
    }
  } catch (error) {
    return preflightError(error);
  }
  return undefined;
}
export async function addBookmark(
  api: ApiCall,
  channelId: string,
  input: BookmarkInput,
  isCurrent: () => boolean = () => true,
): Promise<WriteOutcome> {
  if (!isCurrent()) return failed("認証または対象が変わりました");
  const values = bookmarkInput(input);
  if (!values) return failed("タイトルとHTTP(S)のURLを入力してください");
  const rejected = await checkTarget(api, channelId);
  if (rejected) return rejected;
  if (!isCurrent()) return failed("認証または対象が変わりました");
  return runWrite(
    api,
    "bookmarks.add",
    { channel_id: channelId, type: "link", ...values },
    (raw) => {
      const bookmark = readBookmark(raw.bookmark, channelId);
      return (
        !!bookmark &&
        bookmark.type === "link" &&
        bookmark.title === values.title &&
        bookmark.link === values.link
      );
    },
  );
}
export async function editBookmark(
  api: ApiCall,
  channelId: string,
  original: Bookmark,
  input: BookmarkInput,
  isCurrent: () => boolean = () => true,
): Promise<WriteOutcome> {
  if (!isCurrent()) return failed("認証または対象が変わりました");
  const values = bookmarkInput(input);
  if (!values) return failed("タイトルとHTTP(S)のURLを入力してください");
  const rejected = await checkTarget(api, channelId, original);
  if (rejected) return rejected;
  if (!isCurrent()) return failed("認証または対象が変わりました");
  return runWrite(
    api,
    "bookmarks.edit",
    { channel_id: channelId, bookmark_id: original.id, ...values },
    (raw) => {
      const bookmark = readBookmark(raw.bookmark, channelId);
      return (
        !!bookmark &&
        bookmark.id === original.id &&
        bookmark.type === "link" &&
        bookmark.title === values.title &&
        bookmark.link === values.link
      );
    },
  );
}
export async function removeBookmark(
  api: ApiCall,
  channelId: string,
  original: Bookmark,
  isCurrent: () => boolean = () => true,
): Promise<WriteOutcome> {
  if (!isCurrent()) return failed("認証または対象が変わりました");
  const rejected = await checkTarget(api, channelId, original);
  if (rejected) return rejected;
  if (!isCurrent()) return failed("認証または対象が変わりました");
  return runWrite(api, "bookmarks.remove", {
    channel_id: channelId,
    bookmark_id: original.id,
  });
}
