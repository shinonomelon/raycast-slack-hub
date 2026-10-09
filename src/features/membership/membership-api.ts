import type { Conversation } from "../../shared/types.ts";
import {
  SlackApiError,
  type ApiCall,
  type ApiParams,
} from "../../slack/slack-api.ts";

export const MEMBERSHIP_TIMEOUT_MS = 30_000;
export type MembershipRequest = {
  signal: AbortSignal;
  deadline: number;
  now?: () => number;
};
const unreadable = () =>
  new SlackApiError("unreadable", "参加関係の応答を読み取れませんでした");
export function checkRequest(request: MembershipRequest): number {
  if (request.signal.aborted)
    throw new SlackApiError("aborted", "通信を中断しました");
  const remaining = request.deadline - (request.now ?? Date.now)();
  if (remaining <= 0)
    throw new SlackApiError("timeout", "参加関係の取得が時間切れになりました");
  return remaining;
}
async function pages(
  api: ApiCall,
  method: "users.conversations" | "conversations.members",
  field: string,
  params: ApiParams,
  request: MembershipRequest,
): Promise<unknown[]> {
  const result: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const data = await api(
      method,
      { ...params, limit: 200, ...(cursor ? { cursor } : {}) },
      { signal: request.signal, timeoutMs: checkRequest(request) },
    );
    checkRequest(request);
    if (data.ok !== true || !Array.isArray(data[field])) throw unreadable();
    result.push(...data[field]);
    const metadata = data.response_metadata;
    if (
      metadata !== undefined &&
      (metadata === null ||
        typeof metadata !== "object" ||
        Array.isArray(metadata))
    )
      throw unreadable();
    const next = (metadata as Record<string, unknown> | undefined)?.next_cursor;
    if (next !== undefined && typeof next !== "string") throw unreadable();
    cursor = typeof next === "string" && next.trim() ? next.trim() : undefined;
    if (cursor && seen.has(cursor)) throw unreadable();
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
export async function fetchPersonChannels(
  api: ApiCall,
  userId: string,
  request: MembershipRequest,
): Promise<Conversation[]> {
  if (!/^[UW][A-Z0-9]+$/.test(userId)) throw unreadable();
  const rows = await pages(
    api,
    "users.conversations",
    "channels",
    {
      user: userId,
      types: "public_channel,private_channel",
      exclude_archived: true,
    },
    request,
  );
  const channels = new Map<string, Conversation>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw unreadable();
    const c = row as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[CG][A-Z0-9]+$/.test(c.id))
      throw unreadable();
    for (const field of ["is_archived", "is_im", "is_mpim", "is_private"]) {
      if (c[field] !== undefined && typeof c[field] !== "boolean")
        throw unreadable();
    }
    if (c.is_archived || c.is_im || c.is_mpim) continue;
    if (typeof c.name !== "string" || !c.name.trim()) throw unreadable();
    channels.set(c.id, {
      id: c.id,
      name: c.name.replace(/\p{Cc}/gu, "") || "unnamed",
      type: c.is_private ? "private" : "public",
    });
  }
  return [...channels.values()];
}
export async function fetchChannelMembers(
  api: ApiCall,
  channelId: string,
  request: MembershipRequest,
): Promise<string[]> {
  if (!/^[CG][A-Z0-9]+$/.test(channelId)) throw unreadable();
  const rows = await pages(
    api,
    "conversations.members",
    "members",
    { channel: channelId },
    request,
  );
  if (!rows.every((id) => typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id)))
    throw unreadable();
  return [...new Set(rows as string[])];
}
