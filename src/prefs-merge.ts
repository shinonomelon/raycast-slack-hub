// 設定の読み取りと、Open Channel・Quick Compose からの引き継ぎ（純粋な関数）。
// ファイルの読み書きは prefs-store.ts が行う。@raycast/api を読み込まないので、node のテストから動かせる
import { MEMBERSHIPS, type DictionaryRule, type Membership } from "./search.ts";
import type { Prefs } from "./types.ts";

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

// 保存された設定（Hub の prefs.json、または Open Channel の prefs.json）を読む。
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

// Quick Compose の entries.json で登録したチャンネル（{ id, name }）の ID。
// 登録したメンション相手（targets）は引き継がない。メンションの候補は全員の一覧から選べる
function registeredChannelIds(entries: unknown): string[] {
  if (!isRecord(entries) || !Array.isArray(entries.channels)) return [];
  return entries.channels.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === "string" && entry.id !== ""
      ? [entry.id]
      : [],
  );
}

// 引き継ぎの合成。Open Channel の設定（お気に入り・別名・辞書・絞り込み）をそのまま使い、
// お気に入りには Quick Compose に登録したチャンネルを重複なく足す。
// どちらかが無い・壊れているときは、その分を引き継がない（Quick Compose の初期値も足さない）
export function mergeLegacy(
  openChannel: unknown,
  quickCompose: unknown,
): Prefs {
  const base = parsePrefs(openChannel);
  return {
    ...base,
    favorites: unique([
      ...base.favorites,
      ...registeredChannelIds(quickCompose),
    ]),
  };
}

// 引き継ぎ元の読み出し。ファイルを読むのは prefs-store.ts で、ここでは呼ぶかどうかだけを決める。
// 読めなかったときは undefined を返す
export type LegacyReaders = {
  openChannel: () => unknown;
  quickCompose: () => unknown;
};

// 引き継ぎ元は読むだけで、書き換えない。読み出しが投げても引き継ぎの失敗にせず、無いものとして扱う
function readSafely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

// 初期の設定を決める。
// hub は、Hub の prefs.json を JSON として読んだ値。ファイルが無いときだけ undefined にする
// （壊れている・読めないときは、prefs-store.ts がここを通らず、引き継ぎ元も読まずに空の設定で動く）。
// Hub の prefs.json があれば（hub が undefined でなければ）それだけを使い、引き継ぎ元は読まない。
// 無いとき（初回）だけ引き継ぎ元を読んで合成する。inherited は「初回の引き継ぎをした」で、保存が要ることを示す
export function resolveInitialPrefs(
  hub: unknown,
  legacy: LegacyReaders,
): { prefs: Prefs; inherited: boolean } {
  if (hub !== undefined) return { prefs: parsePrefs(hub), inherited: false };
  return {
    prefs: mergeLegacy(
      readSafely(legacy.openChannel),
      readSafely(legacy.quickCompose),
    ),
    inherited: true,
  };
}
