import { normalizeMatch, type Hit } from "./hits.ts";
import { toPeople, type RawUser } from "./people.ts";
import {
  classifyLastReadFailure,
  classifySearchFailure,
  LAST_READ_TIMEOUT_MS,
  SEARCH_TIMEOUT_MS,
  type LastReadFailure,
  type SearchFailure,
} from "../features/search/search-gate.ts";
import {
  object,
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiParams,
} from "./slack-api.ts";
import { LAST_READ_BUDGET } from "../features/triage/triage.ts";
import type { Conversation, LastReadRow, Person } from "../shared/types.ts";
const LIST_TIMEOUT_MS = 120_000;
// カーソルを最後まで読み、失敗したページがあれば部分的な一覧をキャッシュしない。
async function listPages(
  api: ApiCall,
  method: ApiMethod,
  field: string,
  params: ApiParams,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const started = Date.now();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const remaining = LIST_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0)
      throw new SlackApiError("timeout", "一覧の取得が時間切れになりました");
    const data = await api(
      method,
      { ...params, limit: 200, ...(cursor ? { cursor } : {}) },
      { timeoutMs: remaining },
    );
    if (!Array.isArray(data[field]))
      throw new SlackApiError("unreadable", "一覧の応答を読み取れませんでした");
    rows.push(...data[field]);
    const next = object(data.response_metadata).next_cursor;
    cursor = typeof next === "string" && next.trim() ? next.trim() : undefined;
    if (cursor && seen.has(cursor))
      throw new SlackApiError("unreadable", "一覧のカーソルが繰り返されました");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
export async function listConversations(api: ApiCall): Promise<Conversation[]> {
  const rows = await listPages(api, "conversations.list", "channels", {
    types: "public_channel,private_channel,mpim",
    exclude_archived: true,
  });
  const result = new Map<string, Conversation>();
  for (const raw of rows) {
    const c = object(raw);
    if (
      typeof c.id !== "string" ||
      !/^[CG][A-Z0-9]+$/.test(c.id) ||
      c.is_archived ||
      c.is_im
    )
      continue;
    result.set(c.id, {
      id: c.id,
      name:
        typeof c.name === "string" && c.name
          ? c.name.replace(/\p{Cc}/gu, "") || "unnamed"
          : "unnamed",
      type: c.is_mpim ? "mpim" : c.is_private ? "private" : "public",
    });
  }
  return [...result.values()];
}
export async function listPeople(api: ApiCall): Promise<Person[]> {
  const rows = await listPages(api, "users.list", "members", {});
  const users: RawUser[] = [];
  for (const row of rows) {
    const user = object(row);
    if (
      typeof user.id !== "string" ||
      !/^[UW][A-Z0-9]+$/.test(user.id) ||
      typeof user.name !== "string" ||
      !user.name.trim()
    )
      continue;
    const profile = object(user.profile);
    const text = (value: unknown) =>
      typeof value === "string" ? value : undefined;
    users.push({
      id: user.id,
      name: user.name,
      deleted: user.deleted === true,
      is_bot: user.is_bot === true,
      real_name: text(user.real_name),
      profile: {
        display_name: text(profile.display_name),
        real_name: text(profile.real_name),
        title: text(profile.title),
      },
    });
  }
  return toPeople(users);
}
export async function listJoinedChannelIds(api: ApiCall): Promise<string[]> {
  const rows = await listPages(api, "users.conversations", "channels", {
    types: "public_channel",
    exclude_archived: true,
  });
  return [
    ...new Set(
      rows
        .map(object)
        .filter(
          (c) =>
            !c.is_archived &&
            typeof c.id === "string" &&
            /^C[A-Z0-9]+$/.test(c.id),
        )
        .map((c) => c.id as string),
    ),
  ];
}
export type SearchOutcome =
  | { kind: "ok"; hits: Hit[]; capped?: boolean; pageCount?: number }
  | { kind: "failed"; failure: SearchFailure }
  | { kind: "aborted" };
export type SearchPageOutcome =
  | { kind: "ok"; hits: Hit[]; capped: boolean; pageCount?: number }
  | { kind: "failed"; failure: SearchFailure }
  | { kind: "aborted" };
export async function searchPage(
  query: string,
  options: {
    api: ApiCall;
    selfId: string;
    signal?: AbortSignal;
    now?: () => number;
    sortDir?: "asc" | "desc";
    page?: number;
    timeoutMs?: number;
  },
): Promise<SearchPageOutcome> {
  const { api, selfId, signal, now = Date.now } = options;
  try {
    const data = await api(
      "search.messages",
      {
        query,
        sort: "timestamp",
        sort_dir: options.sortDir ?? "desc",
        count: 100,
        page: options.page ?? 1,
        highlight: false,
      },
      { timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS, signal },
    );
    if (signal?.aborted) return { kind: "aborted" };
    const messages = object(data.messages);
    if (!Array.isArray(messages.matches))
      throw new SlackApiError("unreadable", "検索結果にmatchesがありません");
    const hits = messages.matches
      .map((m) => normalizeMatch(m, selfId))
      .filter((hit): hit is Hit => hit !== undefined);
    const count = messages.total ?? object(messages.pagination).total_count;
    const total =
      typeof count === "number" && Number.isFinite(count)
        ? count
        : messages.matches.length;
    const paging = object(messages.paging);
    const pagination = object(messages.pagination);
    const rawPages = paging.pages ?? pagination.page_count;
    const pageCount =
      typeof rawPages === "number" && Number.isInteger(rawPages) && rawPages > 0
        ? rawPages
        : Math.max(1, Math.ceil(total / 100));
    return {
      kind: "ok",
      hits,
      capped:
        pageCount > (options.page ?? 1) ||
        total > ((options.page ?? 1) - 1) * 100 + messages.matches.length,
      pageCount,
    };
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof SlackApiError && error.kind === "aborted")
    )
      return { kind: "aborted" };
    return { kind: "failed", failure: classifySearchFailure(error, now()) };
  }
}
export async function searchMessages(
  query: string,
  options: {
    api: ApiCall;
    selfId: string;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<SearchOutcome> {
  const result = await searchPage(query, options);
  return result.kind === "ok"
    ? {
        kind: "ok",
        hits: result.hits,
        ...(result.capped ? { capped: true, pageCount: result.pageCount } : {}),
      }
    : result;
}
export type LastReadsOutcome =
  | { kind: "ok"; rows: LastReadRow[] }
  | { kind: "failed"; failure: LastReadFailure };
// 会話単位で既読位置を読み、回数制限後は残りの問い合わせを止める。
export async function getLastReads(
  ids: readonly string[],
  options: { api: ApiCall; now?: () => number },
): Promise<LastReadsOutcome> {
  const requested = [...new Set(ids)]
    .filter((id) => /^[CDG][A-Z0-9]+$/.test(id))
    .slice(0, LAST_READ_BUDGET);
  const rows: LastReadRow[] = [];
  const started = Date.now();
  let limited: number | undefined;
  for (const channelId of requested) {
    if (limited !== undefined) {
      rows.push({
        channelId,
        lastRead: null,
        reason: "rate_limited",
        retryAfter: limited,
      });
      continue;
    }
    try {
      const remaining = LAST_READ_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0)
        throw new SlackApiError(
          "timeout",
          "既読位置の取得が時間切れになりました",
        );
      const data = await options.api(
        "conversations.info",
        { channel: channelId },
        { timeoutMs: remaining },
      );
      const channel = object(data.channel);
      if (channel.id !== channelId)
        throw new SlackApiError(
          "unreadable",
          "既読位置の応答の会話IDが一致しません",
        );
      const ts = channel.last_read;
      rows.push(
        typeof ts === "string" && /^\d{10}\.\d{6}$/.test(ts)
          ? { channelId, lastRead: ts, reason: null }
          : {
              channelId,
              lastRead: null,
              reason: ts === undefined ? "no_last_read" : "error",
            },
      );
    } catch (error) {
      if (error instanceof SlackApiError) {
        if (
          error.kind === "timeout" ||
          [
            "invalid_auth",
            "not_authed",
            "token_revoked",
            "token_expired",
            "account_inactive",
            "missing_scope",
          ].includes(error.code ?? "")
        ) {
          return {
            kind: "failed",
            failure: classifyLastReadFailure(
              error,
              (options.now ?? Date.now)(),
            ),
          };
        }
        if (error.kind === "rate_limited") {
          limited = error.retryAfter ?? 60;
          rows.push({
            channelId,
            lastRead: null,
            reason: "rate_limited",
            retryAfter: limited,
          });
          continue;
        }
        if (
          ["channel_not_found", "not_in_channel", "no_permission"].includes(
            error.code ?? "",
          )
        ) {
          rows.push({ channelId, lastRead: null, reason: "not_visible" });
          continue;
        }
      }
      rows.push({ channelId, lastRead: null, reason: "error" });
    }
  }
  return { kind: "ok", rows };
}
