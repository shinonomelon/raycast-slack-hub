import { recordRequestCacheHit } from "../../slack/request-context.ts";
import { compareTs, normalizeMatch, type Hit } from "../../slack/hits.ts";
import type { Session } from "../../slack/identity.ts";
import { object, SlackApiError, type ApiCall } from "../../slack/slack-api.ts";

export const THREAD_PAGE_SIZE = 15;
export const THREAD_MAX_PAGES = 10;
export const THREAD_MAX_MESSAGES = 150;
export const THREAD_CACHE_MS = 120_000;
const validTs = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d{6}$/.test(value);

export type ThreadContext = {
  messages: Hit[];
  rootTs: string;
  isThread: boolean;
  pages: number;
  cursor?: string;
  seen: string[];
  capped: boolean;
};
export type ThreadFailure = {
  kind: "scope" | "missing" | "rate" | "invalid" | "failed";
  retryAt?: number;
};
export class ThreadContextError extends Error {
  failure: ThreadFailure;
  constructor(failure: ThreadFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

// 認証クライアントが変われば、本文も待機状態も共有しない。
const caches = new WeakMap<
  ApiCall,
  Map<string, { at: number; data: ThreadContext }>
>();
const pauses = new WeakMap<ApiCall, number>();
export function threadContextKey(session: Session, hit: Hit): string {
  return JSON.stringify([
    session.display.teamId,
    session.display.userId,
    hit.channelId,
    hit.threadTs ?? hit.ts,
    hit.ts,
  ]);
}
export function cachedThreadContext(
  session: Session,
  hit: Hit,
  now = Date.now(),
): ThreadContext | undefined {
  if (!session.canFetch) return undefined;
  const cache = caches.get(session.api);
  const key = threadContextKey(session, hit);
  const entry = cache?.get(key);
  if (!entry) return undefined;
  if (now - entry.at >= THREAD_CACHE_MS || now < entry.at) {
    cache?.delete(key);
    return undefined;
  }
  recordRequestCacheHit(session.api, "thread-context");
  return entry.data;
}
function remember(
  session: Session,
  hit: Hit,
  data: ThreadContext,
  now: number,
) {
  let cache = caches.get(session.api);
  if (!cache) caches.set(session.api, (cache = new Map()));
  const key = threadContextKey(session, hit);
  cache.delete(key);
  cache.set(key, { at: now, data });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
}

// 1回の操作で1ページだけ読む。表示のための取得ではAI判定や既読位置を更新しない。
export async function fetchThreadContext(
  session: Session,
  hit: Hit,
  previous?: ThreadContext,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<ThreadContext> {
  if (!session.canFetch || !validTs(hit.ts) || !validTs(hit.threadTs ?? hit.ts))
    throw new ThreadContextError({ kind: "invalid" });
  if (signal?.aborted) throw new ThreadContextError({ kind: "failed" });
  if (previous && (!previous.cursor || previous.capped)) return previous;
  const retryAt = pauses.get(session.api) ?? 0;
  if (retryAt > now()) throw new ThreadContextError({ kind: "rate", retryAt });
  let raw: Record<string, unknown>;
  try {
    raw = await session.api(
      "conversations.replies",
      {
        channel: hit.channelId,
        ts: previous?.rootTs ?? hit.threadTs ?? hit.ts,
        latest: hit.ts,
        inclusive: true,
        limit: THREAD_PAGE_SIZE,
        ...(previous?.cursor ? { cursor: previous.cursor } : {}),
      },
      { signal, source: "thread-context", deadlineAt: now() + 15000 },
    );
  } catch (error) {
    if (error instanceof SlackApiError) {
      if (error.kind === "rate_limited" || error.kind === "deferred") {
        const retryAt = Math.max(
          pauses.get(session.api) ?? 0,
          error.retryAt ?? now() + (error.retryAfter ?? 60) * 1000,
        );
        pauses.set(session.api, retryAt);
        throw new ThreadContextError({ kind: "rate", retryAt });
      }
      if (error.code === "missing_scope")
        throw new ThreadContextError({ kind: "scope" });
      if (
        [
          "thread_not_found",
          "channel_not_found",
          "not_in_channel",
          "access_denied",
        ].includes(error.code ?? "")
      )
        throw new ThreadContextError({ kind: "missing" });
    }
    throw new ThreadContextError({ kind: "failed" });
  }
  if (signal?.aborted) throw new ThreadContextError({ kind: "failed" });
  const invalid = () => new ThreadContextError({ kind: "invalid" });
  if (!Array.isArray(raw.messages) || raw.messages.length > THREAD_PAGE_SIZE)
    throw invalid();
  const rows = raw.messages.map(object);
  const first = rows[0];
  const rootTs = previous?.rootTs ?? first?.ts;
  if (!validTs(rootTs) || compareTs(rootTs, hit.ts) > 0) throw invalid();
  if (!previous && hit.threadTs && rootTs !== hit.threadTs) throw invalid();
  // 最初の投稿は親であることを確かめ、別スレッドや未来の投稿を採用しない。
  if (!previous && first?.thread_ts !== undefined && first.thread_ts !== rootTs)
    throw invalid();
  const page: Hit[] = [];
  for (const row of rows) {
    if (!validTs(row.ts)) throw invalid();
    if (row.text !== undefined && typeof row.text !== "string") throw invalid();
    if (row.channel !== undefined && row.channel !== hit.channelId)
      throw invalid();
    if (row.ts !== rootTs && row.thread_ts !== rootTs) throw invalid();
    if (
      row.ts === rootTs &&
      row.thread_ts !== undefined &&
      row.thread_ts !== rootTs
    )
      throw invalid();
    if (compareTs(row.ts, hit.ts) > 0) continue;
    const item = normalizeMatch(
      { ...row, channel: { id: hit.channelId } },
      session.display.userId,
    );
    if (!item) throw invalid();
    page.push({
      ...item,
      channelKind: hit.channelKind,
      channelName: hit.channelName,
      threadTs: row.ts === rootTs ? undefined : rootTs,
    });
  }
  const messages = [
    ...new Map(
      [...(previous?.messages ?? []), ...page].map((item) => [item.ts, item]),
    ).values(),
  ].sort((a, b) => compareTs(b.ts, a.ts));
  const metadata = object(raw.response_metadata);
  if (
    metadata.next_cursor !== undefined &&
    typeof metadata.next_cursor !== "string"
  )
    throw invalid();
  const cursor =
    (metadata.next_cursor as string | undefined)?.trim() || undefined;
  const more = Boolean(raw.has_more || cursor);
  if (!more && !messages.some((item) => item.ts === hit.ts))
    throw new ThreadContextError({ kind: "missing" });
  const seen = previous?.seen ?? [];
  if (more && (!cursor || seen.includes(cursor))) throw invalid();
  const pages = (previous?.pages ?? 0) + 1;
  const capped =
    more &&
    (pages >= THREAD_MAX_PAGES || messages.length >= THREAD_MAX_MESSAGES);
  const data: ThreadContext = {
    messages: messages.slice(0, THREAD_MAX_MESSAGES),
    rootTs,
    isThread:
      previous?.isThread === true ||
      rootTs !== hit.ts ||
      Number(first?.reply_count ?? 0) > 0 ||
      messages.some((item) => item.ts !== rootTs),
    pages,
    cursor: capped ? undefined : cursor,
    seen: cursor ? [...seen, cursor] : seen,
    capped,
  };
  remember(session, hit, data, now());
  return data;
}
