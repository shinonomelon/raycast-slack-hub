import { toItems } from "../../slack/items.ts";
import { rankItems } from "../search/search.ts";
import type { Person, Prefs } from "../../shared/types.ts";
import type { MembershipState } from "./membership.ts";

export function memberRows(
  ids: readonly string[],
  people: readonly Person[],
  prefs: Prefs,
) {
  const known = new Map(people.map((person) => [person.id, person]));
  const rows = new Map(
    toItems([], people, prefs, []).map((row) => [row.id, row]),
  );
  return ids.map((id) => {
    const person = known.get(id);
    return {
      ...(rows.get(id) ?? {
        id,
        kind: "person" as const,
        title: id,
        keywords: [id],
        aliases: [],
      }),
      person,
      subtitle: person?.isBot
        ? "ボット"
        : person
          ? rows.get(id)?.subtitle
          : "状態未確認",
      actionable: person !== undefined && !person.isBot,
    };
  });
}
export function allMatches<T extends Parameters<typeof rankItems>[0][number]>(
  rows: readonly T[],
  text: string,
): T[] {
  return rankItems(rows, text, rows.length);
}
export function membershipStatus(state: MembershipState): string {
  const time =
    state.fetchedAt === undefined
      ? ""
      : `取得 ${new Date(state.fetchedAt).toLocaleTimeString("ja-JP")}`;
  const previous = state.previous ? "前回取得 · " : "";
  if (state.status === "loading")
    return `${previous}更新中${time ? ` · ${time}` : ""}`;
  if (state.status === "rate-limited")
    return `${previous}${state.error} · ${state.retryAfter}秒後に再試行${time ? ` · ${time}` : ""}`;
  if (state.status === "failed" || state.status === "auth-required")
    return `${previous}${state.error ?? "認証設定を確認し、Hubを開き直してください"}${time ? ` · ${time}` : ""}`;
  return `${state.data.length}件${time ? ` · ${time}` : ""}`;
}
