import { t } from "../../shared/i18n.ts";
import type { Row } from "../../slack/items.ts";
import type { Person } from "../../shared/types.ts";
// 取得済みの値を本文として表示する。改行とMarkdown記号で別の見出し・リンクを作らせない。
export function escapeDetail(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&");
}
const kinds = {
  get channel() {
    return t("公開チャンネル");
  },
  get private() {
    return t("非公開チャンネル");
  },
  get group() {
    return t("グループDM");
  },
  get person() {
    return t("人");
  },
};
export function rowDetail(row: Row, person?: Person): string {
  const fields: [string, string][] = [
    [t("種別"), kinds[row.kind]],
    ...(person?.handle
      ? [[t("ハンドル"), `@${person.handle}`] as [string, string]]
      : []),
    ...(person?.realName
      ? [[t("実名"), person.realName] as [string, string]]
      : []),
    ...(person?.title ? [[t("役職"), person.title] as [string, string]] : []),
    ...(row.aliases.length
      ? [[t("別名"), row.aliases.join("・")] as [string, string]]
      : []),
    ["ID", row.id],
  ];
  return `## ${escapeDetail(row.title)}\n\n${fields.map(([name, value]) => `**${name}**: ${escapeDetail(value)}`).join("\n\n")}`;
}
