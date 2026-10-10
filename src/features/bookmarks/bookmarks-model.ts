import { object, SlackApiError } from "../../slack/slack-api.ts";

export type Bookmark = {
  id: string;
  channelId: string;
  title: string;
  type: string;
  link?: string;
  updatedAt?: number;
};
export type BookmarkInput = { title: string; link: string };
export const validChannelId = (id: string) => /^[CGD][A-Z0-9]+$/.test(id);

// URLを開く・登録する操作はHTTP(S)に限定する。認証情報を含むURLも受け取らない。
export function bookmarkUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    [...trimmed].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname &&
      !url.username &&
      !url.password
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}
export function bookmarkInput(input: BookmarkInput): BookmarkInput | undefined {
  const title = input.title.trim();
  const link = bookmarkUrl(input.link);
  return title && link ? { title, link } : undefined;
}
export function readBookmark(
  value: unknown,
  channelId: string,
): Bookmark | undefined {
  const raw = object(value);
  if (
    typeof raw.id !== "string" ||
    !/^[A-Za-z0-9]+$/.test(raw.id) ||
    raw.channel_id !== channelId ||
    typeof raw.title !== "string" ||
    typeof raw.type !== "string" ||
    raw.type === ""
  )
    return undefined;
  return {
    id: raw.id,
    channelId,
    title: raw.title,
    type: raw.type,
    ...(typeof raw.link === "string" ? { link: raw.link } : {}),
    ...(typeof raw.date_updated === "number" &&
    Number.isFinite(raw.date_updated)
      ? { updatedAt: raw.date_updated }
      : {}),
  };
}
export function readBookmarks(
  raw: Record<string, unknown>,
  channelId: string,
): Bookmark[] {
  if (
    raw.ok !== true ||
    !Array.isArray(raw.bookmarks) ||
    raw.bookmarks.length > 100
  ) {
    throw new SlackApiError(
      "unreadable",
      "ブックマーク一覧の応答を読み取れませんでした",
    );
  }
  const result = new Map<string, Bookmark>();
  for (const value of raw.bookmarks) {
    const bookmark = readBookmark(value, channelId);
    if (!bookmark)
      throw new SlackApiError(
        "unreadable",
        "ブックマークの対象・形式を確認できませんでした",
      );
    result.set(bookmark.id, bookmark);
  }
  return [...result.values()];
}
export function sameBookmark(before: Bookmark, current: Bookmark): boolean {
  return (
    before.id === current.id &&
    before.channelId === current.channelId &&
    before.type === current.type &&
    before.title === current.title &&
    before.link === current.link &&
    before.updatedAt === current.updatedAt
  );
}

// 戻り先にも対象のチャンネルを表示して、別の資料との取り違えを防ぐ。
export function deleteBookmarkConfirmation(
  channelName: string,
  bookmark: Bookmark,
): string {
  return `チャンネル: #${channelName}\nタイトル: ${bookmark.title}\nURL: ${bookmark.link ?? "（URLなし）"}\nこのブックマークを削除します。`;
}
