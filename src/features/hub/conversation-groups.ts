import { t } from "../../shared/i18n.ts";
import type { Row } from "../../slack/items.ts";

// 種別ごとの見出しを付け、各種別の検索順位・お気に入り順位は保つ。
export function conversationGroups(rows: readonly Row[]) {
  return [
    {
      id: "channels",
      title: t("チャンネル"),
      rows: rows.filter(
        (row) => row.kind === "channel" || row.kind === "private",
      ),
    },
    {
      id: "people",
      title: t("ユーザー"),
      rows: rows.filter((row) => row.kind === "person"),
    },
    {
      id: "groups",
      title: t("グループDM一覧"),
      rows: rows.filter((row) => row.kind === "group"),
    },
  ].filter((group) => group.rows.length > 0);
}
