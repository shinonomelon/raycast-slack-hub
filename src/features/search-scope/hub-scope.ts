import { t } from "../../shared/i18n.ts";
import type { Conversation, Person } from "../../shared/types.ts";
import type { ChannelLibrary } from "../channel-library/model.ts";
import type { SearchScope } from "./model.ts";
// チャンネルだけを新しい正本へ切り替え、人物とグループDMの設定を残す。
export function hubFavorites(
  legacy: readonly string[],
  library: ChannelLibrary,
  ready: boolean,
  conversations: readonly Conversation[],
): string[] {
  const groups = new Set(
    conversations.filter((c) => c.type === "mpim").map((c) => c.id),
  );
  return [
    ...new Set([
      ...legacy.filter((id) => !/^[CG]/.test(id) || groups.has(id)),
      ...(ready ? library.favoriteChannelIds : []),
    ]),
  ];
}
export function searchScopeTitle(
  scope: SearchScope,
  library: ChannelLibrary,
  conversations: readonly Conversation[],
  people: readonly Person[],
): string {
  const range = scope.range;
  const label =
    range.kind === "all"
      ? t("すべて")
      : range.kind === "favorites"
        ? t("お気に入りチャンネル")
        : range.kind === "section"
          ? (library.sections.find((s) => s.id === range.sectionId)?.name ??
            t("削除されたセクション"))
          : `#${conversations.find((c) => c.id === range.channelId)?.name ?? t("参照できないチャンネル")}`;
  const sender = people.find((p) => p.id === scope.senderId);
  return scope.senderId
    ? `${label} / ${sender?.displayName || sender?.realName || sender?.handle || t("指定投稿者")}`
    : label;
}
