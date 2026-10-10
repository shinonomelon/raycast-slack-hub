import { createHash } from "node:crypto";
import type { Conversation } from "../../shared/types.ts";
import type { ChannelLibrary } from "../channel-library/model.ts";

export type SearchScope = {
  range:
    | { kind: "all" }
    | { kind: "favorites" }
    | { kind: "section"; sectionId: string }
    | { kind: "channel"; channelId: string };
  senderId?: string;
};
export type ResolvedScope = {
  channelIds: "all" | string[];
  senderId?: string;
  fingerprint: string;
};
export const DEFAULT_SEARCH_SCOPE: SearchScope = { range: { kind: "all" } };
export const validChannelId = (id: string) => /^[CG][A-Z0-9]+$/.test(id);
export const validSenderId = (id: string) => /^[UW][A-Z0-9]+$/.test(id);

export function scopeFingerprint(
  channelIds: "all" | readonly string[],
  senderId?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        channelIds:
          channelIds === "all" ? "all" : [...new Set(channelIds)].sort(),
        senderId: senderId ?? null,
      }),
    )
    .digest("hex");
}

export function resolveScope(
  scope: SearchScope,
  library: ChannelLibrary | undefined,
  conversations: readonly Conversation[],
): {
  resolved: ResolvedScope;
  unresolvedChannelIds: string[];
  missingSection: boolean;
  invalidSender: boolean;
} {
  const range = scope.range;
  const section =
    range.kind === "section"
      ? library?.sections.find((s) => s.id === range.sectionId)
      : undefined;
  const missingSection = scope.range.kind === "section" && !section;
  const requested =
    scope.range.kind === "all"
      ? "all"
      : scope.range.kind === "favorites"
        ? (library?.favoriteChannelIds ?? [])
        : scope.range.kind === "section"
          ? (section?.channelIds ?? [])
          : [scope.range.channelId];
  const available = new Set(
    conversations
      .filter((c) => c.type !== "mpim" && validChannelId(c.id))
      .map((c) => c.id),
  );
  const unresolvedChannelIds =
    requested === "all"
      ? []
      : [...new Set(requested)].filter((id) => !available.has(id)).sort();
  const channelIds =
    requested === "all"
      ? "all"
      : [...new Set(requested)].filter((id) => available.has(id)).sort();
  const invalidSender =
    scope.senderId !== undefined && !validSenderId(scope.senderId);
  // 不正な投稿者を取り除いて全体検索へ広げない。計画生成側で検索を停止する。
  const senderId = scope.senderId;
  return {
    resolved: {
      channelIds,
      senderId,
      fingerprint: scopeFingerprint(channelIds, senderId),
    },
    unresolvedChannelIds,
    missingSection,
    invalidSender,
  };
}

export function validateScopeSelection(
  scope: SearchScope,
  library: ChannelLibrary,
  conversations: readonly Conversation[],
  showMessages = false,
): string | undefined {
  const range = scope.range;
  if (
    range.kind === "section" &&
    !library.sections.some((s) => s.id === range.sectionId)
  )
    return "セクションを選び直してください";
  if (
    range.kind === "channel" &&
    !conversations.some((c) => c.id === range.channelId && c.type !== "mpim")
  )
    return "チャンネルを選び直してください";
  if (scope.senderId !== undefined && !validSenderId(scope.senderId))
    return "投稿者を選び直してください";
  if (showMessages && range.kind === "all" && !scope.senderId)
    return "範囲または投稿者を指定してください";
  return undefined;
}
