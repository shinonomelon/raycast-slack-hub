import { t, getLocale } from "../../shared/i18n.ts";
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
        ? t("ボット")
        : person
          ? rows.get(id)?.subtitle
          : t("状態未確認"),
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
      : t(
          "取得 {0}",
          new Date(state.fetchedAt).toLocaleTimeString(getLocale()),
        );
  const previous = state.previous ? t("前回取得 \u00B7 ") : "";
  if (state.status === "loading")
    return t("{0}更新中{1}", previous, time ? ` · ${time}` : "");
  if (state.status === "rate-limited" || state.status === "deferred")
    return t(
      "{0}{1} \u00B7 {2}秒後に再試行{3}",
      previous,
      state.error,
      state.retryAfter,
      time ? ` · ${time}` : "",
    );
  if (state.status === "failed" || state.status === "auth-required")
    return `${previous}${state.error ?? t("認証設定を確認し、Hubを開き直してください")}${time ? ` · ${time}` : ""}`;
  return t("{0}件{1}", state.data.length, time ? ` · ${time}` : "");
}
