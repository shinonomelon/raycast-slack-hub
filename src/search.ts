export type Kind = "channel" | "private" | "group" | "person";

export type Item = {
  id: string;
  kind: Kind;
  title: string;
  subtitle?: string;
  // 照合に使う文字列（チャンネル名、人の各種名前など）
  keywords: string[];
};

// 全角半角・大文字小文字をそろえる。「ＤＯＣ」でも「doc」に当たるようにする
export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

// 単語の区切りとみなす文字。チャンネル名の _ - . と、人の名前の空白
const WORD_BOUNDARY = /[\s_\-.]/;

// 1つの照合文字列に対する一致の強さ。小さいほど強い。当たらなければ undefined
function matchRank(keyword: string, word: string): number | undefined {
  if (keyword === word) return 0;
  if (keyword.startsWith(word)) return 1;
  const index = keyword.indexOf(word);
  if (index < 0) return undefined;
  return WORD_BOUNDARY.test(keyword[index - 1]) ? 2 : 3;
}

// 名前の空白を詰めた形も照合に使う。「原野 翔太」を「原野翔太」でも引けるようにする
function variants(keyword: string): string[] {
  const k = normalize(keyword);
  const compact = k.replace(/\s+/g, "");
  return compact === k ? [k] : [k, compact];
}

type Match = { tier: number; penalty: number };
type SearchKey = { text: string; points?: string[]; typoTerms?: string[] };

// 英数字の入力ミスだけを補正する。区切り文字を含む名前全体も比較できる。
const ASCII_NAME = /^[a-z0-9_.-]+$/;

// 編集距離1だけを調べる。隣接2文字の入れ替えも1回の入力ミスとする。
// 長い名前への任意の部分一致は行わず、語全体を比較する。
function oneError(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (i === Math.min(a.length, b.length)) return true;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return (
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2)
    );
  }
  return a.length > b.length
    ? a.slice(i + 1) === b.slice(i)
    : a.slice(i) === b.slice(i + 1);
}

// 各接頭部分の最も新しい開始位置を保ち、順序を守る最短一致区間を求める。
// 後ろから更新して同じ文字を二度使わない。文字数はUTF-16の長さではなく文字単位で数える。
function skippedPenalty(points: string[], word: string[]): number | undefined {
  const starts = new Int32Array(word.length).fill(-1);
  let shortest = Infinity;
  for (let pos = 0; pos < points.length; pos++) {
    for (let j = word.length - 1; j >= 0; j--) {
      if (points[pos] !== word[j]) continue;
      const start = j === 0 ? pos : starts[j - 1];
      if (start < 0) continue;
      starts[j] = start;
      if (j === word.length - 1) shortest = Math.min(shortest, pos - start + 1);
    }
  }
  return shortest <= word.length * 2 ? shortest - word.length : undefined;
}

function fuzzyMatch(
  key: SearchKey,
  word: string,
  points: string[],
): Match | undefined {
  if (points.length >= 4 && ASCII_NAME.test(word)) {
    key.typoTerms ??= [key.text, ...key.text.split(WORD_BOUNDARY)].filter(
      (term) => ASCII_NAME.test(term),
    );
    if (key.typoTerms.some((term) => oneError(term, word)))
      return { tier: 4, penalty: 1 };
  }
  if (points.length < 3) return undefined;
  key.points ??= Array.from(key.text);
  const penalty = skippedPenalty(key.points, points);
  return penalty === undefined ? undefined : { tier: 5, penalty };
}

// 検索語の全単語を照合する。既存一致、誤字、飛び飛び一致の順に並べる。
// 同じ階層ではファジーの総ペナルティを比べ、同じなら元の並びを保つ。
export function rankItems<T extends Item>(
  items: readonly T[],
  query: string,
  limit = 100,
): T[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const queries = words.map((word) => ({ word, points: Array.from(word) }));
  const ranked: { item: T; rank: number; penalty: number; index: number }[] =
    [];
  items.forEach((item, index) => {
    const keys: SearchKey[] = item.keywords
      .flatMap(variants)
      .map((text) => ({ text }));
    let worst = 0;
    let penalty = 0;
    for (const { word, points } of queries) {
      let best: Match | undefined;
      // 全照合語の既存一致を先に調べ、見つかればファジー計算を省く。
      for (const key of keys) {
        const tier = matchRank(key.text, word);
        if (tier !== undefined && (!best || tier < best.tier))
          best = { tier, penalty: 0 };
        if (best?.tier === 0) break;
      }
      if (!best) {
        for (const key of keys) {
          const match = fuzzyMatch(key, word, points);
          if (
            match &&
            (!best ||
              match.tier < best.tier ||
              (match.tier === best.tier && match.penalty < best.penalty))
          )
            best = match;
        }
      }
      if (!best) return;
      worst = Math.max(worst, best.tier);
      penalty += best.penalty;
    }
    ranked.push({ item, rank: worst, penalty, index });
  });
  ranked.sort(
    (a, b) => a.rank - b.rank || a.penalty - b.penalty || a.index - b.index,
  );
  return ranked.slice(0, limit).map((r) => r.item);
}

// グループDMの名前 mpdm-a--b--c-1 から、自分を除いた参加者のハンドルを取り出す
export function mpimHandles(
  name: string,
  selfHandles: readonly string[],
): string[] {
  const body = name.replace(/^mpdm-/, "").replace(/-\d+$/, "");
  return body.split("--").filter((h) => h && !selfHandles.includes(h));
}

// グループDMの名前を、参加者の表示名を並べた形にする。表示名が分からないハンドルはそのまま出す
export function mpimDisplayName(
  name: string,
  handleToName: ReadonlyMap<string, string>,
  selfHandles: readonly string[],
): string {
  return mpimHandles(name, selfHandles)
    .map((h) => handleToName.get(h) ?? h)
    .join(", ");
}

export type DictionaryRule = { from: string; to: string };

// 辞書の規則をすべて当てた名前を作る。チャンネル名は自分では変えられないので、
// 自分の呼び方（例: 自動取得 → auto）に置き換えた名前を照合語に足すために使う。
// 短い規則が長い規則の一部を先に書き換えないよう、長い順に当てる
export function applyDictionary(
  name: string,
  rules: readonly DictionaryRule[],
): string {
  return [...rules]
    .filter((r) => normalize(r.from))
    .sort((a, b) => normalize(b.from).length - normalize(a.from).length)
    .reduce(
      (text, r) => text.replaceAll(normalize(r.from), normalize(r.to)),
      normalize(name),
    );
}

// 未読のあるものを先に、その中と外でそれぞれお気に入りを先に並べる。
// それ以外の並び（最近開いた順など）は保つ
export function orderItems<T extends Item>(
  items: readonly T[],
  favorites: ReadonlySet<string>,
  unread: ReadonlySet<string> = new Set(),
): T[] {
  const group = (i: T) =>
    (unread.has(i.id) ? 0 : 2) + (favorites.has(i.id) ? 0 : 1);
  return items
    .map((item, index) => ({ item, index, group: group(item) }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map((x) => x.item);
}

export type Membership = "all" | "joined" | "notJoined";

export const MEMBERSHIPS: readonly Membership[] = [
  "all",
  "joined",
  "notJoined",
];

// キーで切り替えるときの次の絞り込み。すべて → 参加中 → 未参加 → すべて
export function nextMembership(current: Membership): Membership {
  const index = MEMBERSHIPS.indexOf(current);
  return MEMBERSHIPS[(index + 1) % MEMBERSHIPS.length];
}

// 参加しているかで絞る。参加中＝参加している公開チャンネル＋非公開チャンネル＋グループDM
// （この2つは参加しているものしか一覧に出ない）、未参加＝参加していない公開チャンネル。
// 人はふだん「すべて」のときだけ出す。ただし未読の DM がある人は、その DM に参加しているので参加中にも出す
export function filterByMembership<T extends Item>(
  items: readonly T[],
  membership: Membership,
  joinedIds: ReadonlySet<string>,
  unreadIds: ReadonlySet<string> = new Set(),
): T[] {
  if (membership === "all") return [...items];
  return items.filter((i) => {
    if (i.kind === "person")
      return membership === "joined" && unreadIds.has(i.id);
    const joined = i.kind !== "channel" || joinedIds.has(i.id);
    return membership === "joined" ? joined : !joined;
  });
}
