import {
  parseQuery,
  resolveQuery,
  type FilterSource,
} from "../search/query.ts";
import {
  scopeFingerprint,
  validChannelId,
  validSenderId,
  type ResolvedScope,
} from "./model.ts";

export type MessageSearchPlan = {
  queries: string[];
  resolvedQuery: string;
  conflicts: string[];
  empty: boolean;
  canSearch: boolean;
  scope: ResolvedScope;
};

export function createMessageSearchPlan({
  text,
  scope,
  sources,
  selfId,
}: {
  text: string;
  scope: ResolvedScope;
  sources: readonly FilterSource[];
  selfId: string;
}): MessageSearchPlan {
  const structured = scope.channelIds !== "all" || scope.senderId !== undefined;
  const resolved = resolveQuery(text, sources, selfId);
  const conflicts: string[] = [];
  const finish = (
    queries: string[],
    channels = scope.channelIds,
    senderId = scope.senderId,
  ): MessageSearchPlan => ({
    queries,
    resolvedQuery: resolved.query,
    conflicts,
    empty: queries.length === 0 && conflicts.length === 0,
    canSearch: queries.length > 0 && conflicts.length === 0,
    scope: {
      channelIds: channels,
      senderId,
      fingerprint: scopeFingerprint(channels, senderId),
    },
  });
  if (!structured)
    return finish(
      text.trim().length > 1 && resolved.query ? [resolved.query] : [],
    );
  if (
    (scope.senderId !== undefined && !validSenderId(scope.senderId)) ||
    (scope.channelIds !== "all" &&
      scope.channelIds.some((id) => !validChannelId(id)))
  )
    conflicts.push("検索条件のIDが不正です");
  const positive = parseQuery(text).tokens.filter(
    (t) =>
      t.type === "filter" &&
      !t.negated &&
      (t.modifier === "in" || t.modifier === "from"),
  );
  if (
    ["in", "from"].some(
      (modifier) =>
        positive.filter((t) => t.type === "filter" && t.modifier === modifier)
          .length > 1,
    )
  )
    conflicts.push("複数のin/from条件は選択条件と併用できません");
  // 括弧・ORによる結合は既存の単語resolverでは意味を保証できない。
  const unquoted = text.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, "");
  const hasOr = parseQuery(unquoted).tokens.some(
    (token) => token.type === "text" && /^OR$/i.test(token.raw),
  );
  if (/[()]/.test(unquoted) || hasOr)
    conflicts.push("括弧またはORの条件を修正してください");
  if (
    resolved.unresolved.some(
      (t) => t.modifier === "in" || t.modifier === "from",
    ) ||
    (resolved.completing &&
      (resolved.completing.modifier === "in" ||
        resolved.completing.modifier === "from"))
  )
    conflicts.push("in/from条件の対象を確定してください");
  if (positive.some((token) => token.type === "filter" && !token.value.trim()))
    conflicts.push("in/from条件の値を指定してください");
  if (conflicts.length) return finish([]);
  let channels = scope.channelIds;
  let senderId = scope.senderId;
  let empty = false;
  const retained: string[] = [];
  for (const token of parseQuery(resolved.query).tokens) {
    if (
      token.type !== "filter" ||
      token.negated ||
      (token.modifier !== "in" && token.modifier !== "from")
    ) {
      retained.push(token.raw);
      continue;
    }
    const channel = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token.value);
    const user = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token.value);
    if (token.modifier === "in" && channel) {
      channels =
        channels === "all"
          ? [channel[1]]
          : channels.filter((id) => id === channel[1]);
    } else if (token.modifier === "in" && user) {
      if (channels === "all") retained.push(token.raw);
      else empty = true;
    } else if (token.modifier === "from" && (user || token.value === "me")) {
      const id = user?.[1] ?? selfId;
      if (senderId && senderId !== id) empty = true;
      else senderId = id;
    } else {
      conflicts.push("in/from条件を安全に解釈できません");
    }
  }
  if (empty || conflicts.length) return finish([], channels, senderId);
  const suffix = senderId ? `from:<@${senderId}>` : "";
  const query = (channelId?: string) =>
    [
      ...retained,
      ...(channelId ? [`in:<#${channelId}>`] : []),
      ...(suffix ? [suffix] : []),
    ].join(" ");
  return finish(
    channels === "all" ? [query()] : channels.map((id) => query(id)),
    channels,
    senderId,
  );
}

export function createReplySearchPlan(
  scope: ResolvedScope,
  selfId: string,
  afterDate: string,
  beforeDate?: string,
): string[] {
  if (
    !validSenderId(selfId) ||
    (scope.senderId !== undefined && !validSenderId(scope.senderId)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(afterDate) ||
    (beforeDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) ||
    (scope.channelIds !== "all" &&
      scope.channelIds.some((id) => !validChannelId(id)))
  )
    throw new Error("検索計画の条件が不正です");
  const suffix = [
    `after:${afterDate}`,
    ...(beforeDate ? [`before:${beforeDate}`] : []),
    ...(scope.senderId ? [`from:<@${scope.senderId}>`] : []),
  ].join(" ");
  return scope.channelIds === "all"
    ? [`<@${selfId}> ${suffix}`, `to:me ${suffix}`]
    : [...new Set(scope.channelIds)]
        .sort()
        .map((id) => `<@${selfId}> in:<#${id}> ${suffix}`);
}
