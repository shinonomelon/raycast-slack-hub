import { compareTs, type Hit } from "../../slack/hits.ts";
import { object, SlackApiError } from "../../slack/slack-api.ts";

export const HISTORY_PAGE_SIZE = 15;
export const HISTORY_WINDOW_SECONDS = 600;
export const MAX_HISTORY_MESSAGES = 500;
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
export const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d{10}\.\d{6}$/.test(value);
export type HistoryMessage = {
  channelId: string;
  ts: string;
  threadTs?: string;
  userId?: string;
  username?: string;
  fullText: string;
  reactions: { name: string; count: number }[];
};
export type HistoryPage = {
  messages: HistoryMessage[];
  cursor?: string;
  limited: boolean;
};
export type HistoryRange = { oldest: string; latest: string };
export function historyUnreadable(): SlackApiError {
  return new SlackApiError("unreadable", "履歴の応答を読み取れませんでした");
}
export function timestampAt(seconds: number): string {
  const whole = Math.floor(seconds);
  const fraction = Math.floor(seconds * 1_000_000 - whole * 1_000_000);
  return `${whole}.${String(fraction).padStart(6, "0")}`;
}
export function initialHistoryRange(
  ts: string,
  openedAt: number,
): HistoryRange {
  const seconds = Number(ts.split(".")[0]);
  return {
    oldest: timestampAt(Math.max(0, seconds - HISTORY_WINDOW_SECONDS)),
    latest: timestampAt(
      Math.min(seconds + HISTORY_WINDOW_SECONDS, openedAt / 1000),
    ),
  };
}
export function normalizeHistoryMessage(
  channelId: string,
  raw: unknown,
): HistoryMessage {
  const row = object(raw);
  if (
    !validTimestamp(row.ts) ||
    (row.thread_ts !== undefined && !validTimestamp(row.thread_ts))
  )
    throw historyUnreadable();
  if (row.text !== undefined && typeof row.text !== "string")
    throw historyUnreadable();
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.map(object)
    : [];
  const fallback = attachments.find((attachment) =>
    [attachment.text, attachment.fallback, attachment.pretext].some(
      (value) => typeof value === "string" && value,
    ),
  );
  const fullText =
    typeof row.text === "string" && row.text
      ? row.text
      : ([fallback?.text, fallback?.fallback, fallback?.pretext].find(
          (value) => typeof value === "string" && value,
        ) ?? "");
  const reactions = Array.isArray(row.reactions)
    ? row.reactions
        .map(object)
        .flatMap((reaction) =>
          typeof reaction.name === "string" &&
          typeof reaction.count === "number" &&
          reaction.count >= 0
            ? [{ name: reaction.name, count: reaction.count }]
            : [],
        )
    : [];
  return {
    channelId,
    ts: row.ts,
    threadTs: row.thread_ts as string | undefined,
    userId: typeof row.user === "string" ? row.user : undefined,
    username: typeof row.username === "string" ? row.username : undefined,
    fullText: fullText as string,
    reactions,
  };
}
export function parseHistoryPage(
  channelId: string,
  data: Record<string, unknown>,
): HistoryPage {
  if (data.ok !== true || !Array.isArray(data.messages))
    throw historyUnreadable();
  if (
    data.response_metadata !== undefined &&
    (data.response_metadata === null ||
      typeof data.response_metadata !== "object" ||
      Array.isArray(data.response_metadata))
  )
    throw historyUnreadable();
  if (data.is_limited !== undefined && typeof data.is_limited !== "boolean")
    throw historyUnreadable();
  const metadata = object(data.response_metadata);
  const next = metadata.next_cursor;
  if (next !== undefined && typeof next !== "string") throw historyUnreadable();
  if (data.has_more !== undefined && typeof data.has_more !== "boolean")
    throw historyUnreadable();
  const cursor =
    typeof next === "string" && next.trim() ? next.trim() : undefined;
  // 続きがあるのにcursorが無い応答を取得完了と表示しない。
  if (data.has_more === true && !cursor) throw historyUnreadable();
  return {
    messages: data.messages.map((raw) =>
      normalizeHistoryMessage(channelId, raw),
    ),
    cursor,
    limited: data.is_limited === true,
  };
}
export function mergeHistory(
  previous: readonly HistoryMessage[],
  next: readonly HistoryMessage[],
) {
  const rows = new Map(
    previous.map((message) => [`${message.channelId}:${message.ts}`, message]),
  );
  for (const message of next)
    rows.set(`${message.channelId}:${message.ts}`, message);
  const sorted = [...rows.values()].sort((a, b) => compareTs(a.ts, b.ts));
  let bytes = 0;
  const messages: HistoryMessage[] = [];
  for (const message of sorted) {
    const size = Buffer.byteLength(message.fullText, "utf8");
    if (
      messages.length >= MAX_HISTORY_MESSAGES ||
      bytes + size > MAX_HISTORY_BYTES
    )
      return { messages, capped: true };
    messages.push(message);
    bytes += size;
  }
  return {
    messages,
    capped:
      messages.length >= MAX_HISTORY_MESSAGES || bytes >= MAX_HISTORY_BYTES,
  };
}
export function historyHit(
  message: HistoryMessage,
  source: Hit,
  selfId: string,
  parentTs?: string,
): Hit {
  return {
    ...source,
    key: `${message.channelId}:${message.ts}`,
    channelId: message.channelId,
    ts: message.ts,
    threadTs: parentTs ?? message.threadTs,
    userId: message.userId,
    username: message.username,
    text:
      message.fullText.length > 300
        ? `${message.fullText.slice(0, 300)}…`
        : message.fullText,
    // 検索時の別投稿のパーマリンクを履歴行へ流用しない。
    permalink: message.ts === source.ts ? source.permalink : "",
    mentionsSelf:
      message.fullText.includes(`<@${selfId}>`) ||
      message.fullText.includes(`<@${selfId}|`),
  };
}
export function resolveThreadParent(
  page: HistoryPage,
  requestedTs: string,
): string | undefined {
  const parent = page.messages[0];
  if (
    !parent ||
    (parent.threadTs !== undefined && parent.threadTs !== parent.ts)
  )
    return undefined;
  if (compareTs(parent.ts, requestedTs) > 0) return undefined;
  if (
    page.messages.some(
      (message) => message.ts !== parent.ts && message.threadTs !== parent.ts,
    )
  )
    return undefined;
  return parent.ts;
}

// 返信単件の応答は親を含まない。thread_tsは再取得先の候補にだけ使う。
export function threadParentCandidate(
  page: HistoryPage,
  requestedTs: string,
): string | undefined {
  if (page.cursor || page.messages.length !== 1 || !validTimestamp(requestedTs))
    return undefined;
  const reply = page.messages[0];
  if (
    reply.ts !== requestedTs ||
    !validTimestamp(reply.threadTs) ||
    compareTs(reply.threadTs, requestedTs) >= 0
  )
    return undefined;
  return reply.threadTs;
}
