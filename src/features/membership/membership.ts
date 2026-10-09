import type { Conversation } from "../../shared/types.ts";

export const MAX_PEOPLE = 5;
export type MembershipTarget =
  | { kind: "channels"; userIds: readonly string[] }
  | { kind: "members"; channelId: string };
export type MembershipData = readonly Conversation[] | readonly string[];
export type MembershipState = {
  status:
    | "idle"
    | "loading"
    | "ready"
    | "empty"
    | "failed"
    | "rate-limited"
    | "auth-required";
  data: MembershipData;
  fetchedAt?: number;
  error?: string;
  retryAfter?: number;
  previous?: boolean;
};
export function addPerson(ids: readonly string[], id: string): string[] {
  if (ids.includes(id) || ids.length >= MAX_PEOPLE) return [...ids];
  return [...ids, id];
}
export function removePerson(ids: readonly string[], id: string): string[] {
  return ids.length <= 1 ? [...ids] : ids.filter((value) => value !== id);
}
export function intersectChannels(
  groups: readonly (readonly Conversation[])[],
): Conversation[] {
  if (!groups.length) return [];
  const others = groups
    .slice(1)
    .map((group) => new Set(group.map((channel) => channel.id)));
  return [
    ...new Map(groups[0].map((channel) => [channel.id, channel])).values(),
  ].filter((channel) => others.every((ids) => ids.has(channel.id)));
}
export function targetKey(target: MembershipTarget): string {
  return target.kind === "members"
    ? `members:${target.channelId}`
    : `channels:${[...new Set(target.userIds)].sort().join(",")}`;
}
