// Slack Hub自身の設定を読む純粋な関数。
// ファイルの読み書きは prefs-store.ts が行う。@raycast/api を読み込まないので、node のテストから動かせる
import {
  MEMBERSHIPS,
  type DictionaryRule,
  type Membership,
} from "../search/search.ts";
import type { Prefs } from "../../shared/types.ts";

// 呼ぶたびに新しい値を返す。配列やオブジェクトを使い回すと、書き換えが次の呼び出しに残る
export function emptyPrefs(): Prefs {
  return { favorites: [], aliases: {}, dictionary: [], membership: "all" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 配列でなければ無いものとして扱い、文字列でない要素と空の文字列は捨てる
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}

// 先に出たものを残して重複を除く
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// 保存された設定（Hubのprefs.json）を読む。
// 形が違う項目は無いものとして扱い、読み込みをエラーにしない
export function parsePrefs(raw: unknown): Prefs {
  const source = isRecord(raw) ? raw : {};

  const aliases: Record<string, string[]> = {};
  if (isRecord(source.aliases)) {
    for (const [id, names] of Object.entries(source.aliases)) {
      const list = strings(names);
      if (list.length > 0) aliases[id] = list;
    }
  }

  const dictionary: DictionaryRule[] = Array.isArray(source.dictionary)
    ? source.dictionary.flatMap((rule: unknown) =>
        isRecord(rule) &&
        typeof rule.from === "string" &&
        rule.from !== "" &&
        typeof rule.to === "string"
          ? [{ from: rule.from, to: rule.to }]
          : [],
      )
    : [];

  const membership: Membership =
    typeof source.membership === "string" &&
    (MEMBERSHIPS as readonly string[]).includes(source.membership)
      ? (source.membership as Membership)
      : "all";

  return {
    favorites: unique(strings(source.favorites)),
    aliases,
    dictionary,
    membership,
  };
}
