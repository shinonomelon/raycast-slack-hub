import {
  applyDictionary,
  mpimDisplayName,
  mpimHandles,
  normalize,
  type Item,
} from "../features/search/search.ts";
// 型だけを読む。値として読むと、テストの読み込みが連鎖して増える
import type { FilterSource } from "../features/search/query.ts";
import type { Conversation, Person, Prefs } from "../shared/types.ts";

// 会話と人の一覧の項目
export type Row = Item & { aliases: string[] };

// selfHandles は自分のハンドルの一覧（auth.test の user と Previous Handles）。グループDMの名前から自分を除くのに使う
export function toItems(
  conversations: readonly Conversation[],
  people: readonly Person[],
  prefs: Prefs,
  selfHandles: readonly string[],
): Row[] {
  const handleToName = new Map(people.map((p) => [p.handle, p.displayName]));
  // 照合語に、辞書で置き換えた名前（元と同じなら足さない）と自分で付けた別名を足す
  const withPrefs = (id: string, name: string, keywords: string[]) => {
    const aliases = prefs.aliases[id] ?? [];
    const replaced = applyDictionary(name, prefs.dictionary);
    return {
      aliases,
      keywords: [
        ...keywords,
        ...(replaced !== normalize(name) ? [replaced] : []),
        ...aliases,
      ],
    };
  };
  const items: Row[] = [];
  for (const c of conversations) {
    if (c.type === "mpim") {
      const title = mpimDisplayName(c.name, handleToName, selfHandles);
      // 生の名前 mpdm-… は自分のハンドルを含むので照合に使わない。使うと自分のハンドルに近い語で全グループDMが当たる
      items.push({
        id: c.id,
        kind: "group",
        title,
        ...withPrefs(c.id, title, [title, ...mpimHandles(c.name, selfHandles)]),
      });
    } else {
      items.push({
        id: c.id,
        kind: c.type === "private" ? "private" : "channel",
        title: c.name,
        ...withPrefs(c.id, c.name, [c.name]),
      });
    }
  }
  for (const p of people) {
    const aliases = prefs.aliases[p.id] ?? [];
    items.push({
      id: p.id,
      kind: "person",
      title: p.displayName,
      subtitle: [p.realName !== p.displayName ? p.realName : "", `@${p.handle}`]
        .filter(Boolean)
        .join("  "),
      aliases,
      keywords: [...new Set([p.displayName, p.realName, p.handle, ...aliases])],
    });
  }
  // 最近開いていないものは、名前の短い順に出す。検索語に近い短い名前ほど目的のものである見込みが高い
  return items.sort(
    (a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title),
  );
}

// Search Messages の検索欄の候補。in: に使うチャンネルは #正式名、from:・to: に使う人は @ハンドル を検索欄の語にする。
// グループDMは名前にカンマと空白を含み検索欄の語にしにくいので、候補にしない
export function toFilterSources(
  items: readonly Row[],
  people: readonly Person[],
): FilterSource[] {
  const handles = new Map(people.map((p) => [p.id, p.handle]));
  const sources: FilterSource[] = [];
  for (const item of items) {
    if (item.kind === "channel" || item.kind === "private") {
      sources.push({ ...item, token: `#${item.title}` });
    } else if (item.kind === "person") {
      const handle = handles.get(item.id);
      if (handle) sources.push({ ...item, token: `@${handle}` });
    }
  }
  return sources;
}
