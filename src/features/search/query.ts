import { normalize, orderItems, rankItems, type Item } from "./search.ts";

export type Modifier = "from" | "to" | "in";

export type FilterToken = {
  type: "filter";
  modifier: Modifier;
  negated: boolean;
  value: string;
  raw: string;
  // 検索欄の文字列の中での開始位置。候補を選んだときに、この語だけを書き換えるのに使う
  start: number;
};

export type Token =
  | { type: "text"; raw: string; start: number }
  | { type: "other"; raw: string; start: number }
  | FilterToken;

// 引用符で囲んだ句は1語として扱う。JavaScript の \s は全角の空白にも当たるので、全角の空白も区切りになる
const TOKEN = /"[^"]*"?|\S+/g;
// 全角のコロンでも絞り込みとして読む（日本語入力のまま打てるように）
const FILTER = /^(-?)(from|to|in)[:：](.*)$/i;
// Slack の検索がそのまま理解する修飾子。変換せずに渡す
const OTHER = /^-?(after|before|on|during|has|is|with)[:：]/i;

export function parseQuery(text: string): {
  tokens: Token[];
  endsWithSpace: boolean;
} {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const filter = FILTER.exec(raw);
    if (filter) {
      tokens.push({
        type: "filter",
        modifier: filter[2].toLowerCase() as Modifier,
        negated: filter[1] === "-",
        value: filter[3],
        raw,
        start,
      });
    } else if (OTHER.test(raw)) {
      tokens.push({ type: "other", raw: raw.replace("：", ":"), start });
    } else {
      tokens.push({ type: "text", raw, start });
    }
  }
  return { tokens, endsWithSpace: /\s$/.test(text) };
}

// いま入力中の絞り込みの語。末尾の語が絞り込みで、まだ空白を打っていないとき
export function completingToken(parsed: {
  tokens: Token[];
  endsWithSpace: boolean;
}): FilterToken | undefined {
  const last = parsed.tokens[parsed.tokens.length - 1];
  return last?.type === "filter" && !parsed.endsWithSpace ? last : undefined;
}

// 候補の元。Open Channel と同じ項目に、検索欄に書く正式な語（#チャンネル名・@ハンドル）を足したもの
export type FilterSource = Item & { token: string };

export type Candidate = {
  modifier: Modifier;
  negated: boolean;
  token: string;
  id: string;
  title: string;
  subtitle?: string;
  kind: Item["kind"] | "self";
};

const SELF_TOKEN = "me";

const stripPrefix = (value: string) => value.replace(/^[#@]/, "");

// in:@相手 は、その人との DM を指す。頭の @ で人の中から探す（名前が同じチャンネルと取り違えないよう、
// 頭の記号を取る前に見分ける）
function isDirectMessageFilter(filter: FilterToken): boolean {
  return filter.modifier === "in" && filter.value.trim().startsWith("@");
}

// 絞り込みの値が指す相手を探す候補元。候補を出す側（candidatesFor）と、検索式に直す側（findTarget）の
// 両方がここを通る。別々に決めると、候補で選んだ語が検索式で別の相手を指してしまう
function poolFor(
  filter: FilterToken,
  sources: readonly FilterSource[],
): FilterSource[] {
  // in:@相手 は DM なので、from:・to: と同じく人から探す
  if (isDirectMessageFilter(filter)) {
    return sources.filter((s) => s.kind === "person");
  }
  // in: はチャンネルだけ。グループDMは名前にカンマと空白を含み、検索欄の語にしにくい
  return filter.modifier === "in"
    ? sources.filter((s) => s.kind === "channel" || s.kind === "private")
    : sources.filter((s) => s.kind === "person");
}

// 候補元の並びを、お気に入りを先に、そのあとは渡された並び（最近開いた順）のままにする。
// candidatesFor は一致の強さで並べ、強さが同じなら元の並びを保つので、この並びで渡せば、
// 同じ強さの候補はお気に入り → 最近開いた順に出る（辞書で置き換えた名前に、前方一致するチャンネルが複数あるときなど）
export function orderSources(
  sources: readonly FilterSource[],
  favorites: ReadonlySet<string>,
): FilterSource[] {
  return orderItems(sources, favorites);
}

// 入力中の絞り込みの候補。並びは rankItems（一致の強さ → 元の並び）なので、辞書と別名が効く。
// 元の並びは呼び出し側が orderSources で、お気に入り → 最近開いた順にそろえて渡す
export function candidatesFor(
  filter: FilterToken,
  sources: readonly FilterSource[],
  selfId: string,
  limit = 8,
): Candidate[] {
  const fragment = stripPrefix(filter.value);
  const base = { modifier: filter.modifier, negated: filter.negated };
  const self: Candidate[] =
    filter.modifier !== "in" && SELF_TOKEN.startsWith(normalize(fragment))
      ? [
          {
            ...base,
            token: SELF_TOKEN,
            id: selfId,
            title: "自分",
            kind: "self",
          },
        ]
      : [];
  const ranked = rankItems(poolFor(filter, sources), fragment, limit);
  return [
    ...self,
    ...ranked.map((s) => ({
      ...base,
      token: s.token,
      id: s.id,
      title: s.title,
      subtitle: s.subtitle,
      kind: s.kind,
    })),
  ].slice(0, limit);
}

// 入力中の語を、選んだ候補の正式な語に書き換える。後ろに空白を足して、絞り込みを確定させる
export function applyCandidate(
  text: string,
  filter: FilterToken,
  candidate: Candidate,
): string {
  const prefix = `${candidate.negated ? "-" : ""}${candidate.modifier}:`;
  return `${text.slice(0, filter.start)}${prefix}${candidate.token} `;
}

// 絞り込みの値が指す相手を1つに決める。正式な語に完全一致するものを優先し、
// 無ければ照合語（名前・辞書で置き換えた名前・別名）に完全一致するものを使う。
// 複数に当たるときは決めない（勝手に選ぶと、意図しない相手で絞ってしまうため）
function findTarget(
  filter: FilterToken,
  sources: readonly FilterSource[],
): FilterSource | undefined {
  const target = normalize(stripPrefix(filter.value));
  const pool = poolFor(filter, sources);
  const byToken = pool.filter(
    (s) => normalize(stripPrefix(s.token)) === target,
  );
  if (byToken.length === 1) return byToken[0];
  if (byToken.length > 1) return undefined;
  const byKeyword = pool.filter((s) =>
    s.keywords.some((k) => normalize(k) === target),
  );
  return byKeyword.length === 1 ? byKeyword[0] : undefined;
}

export type ResolvedFilter = {
  modifier: Modifier;
  negated: boolean;
  label: string;
};

export type ResolvedQuery = {
  // Slack に送る検索式。入力中の絞り込みは含めない
  query: string;
  filters: ResolvedFilter[];
  // 確定したのに相手が決まらなかった絞り込み
  unresolved: FilterToken[];
  completing?: FilterToken;
};

// 検索欄の文字列を、Slack の検索式に変える。from:@ハンドル → from:<@U…>、in:#名前 → in:<#C…>、
// in:@相手 → in:<@U…>（DM。2026年10月4日に、この形でその人との DM だけが返ることを確かめた）
export function resolveQuery(
  text: string,
  sources: readonly FilterSource[],
  selfId: string,
): ResolvedQuery {
  const parsed = parseQuery(text);
  const completing = completingToken(parsed);
  const parts: string[] = [];
  const filters: ResolvedFilter[] = [];
  const unresolved: FilterToken[] = [];
  for (const token of parsed.tokens) {
    if (token === completing) continue;
    if (token.type !== "filter") {
      parts.push(token.raw);
      continue;
    }
    const value = token.value.trim();
    // 値の無い絞り込み（from: だけで空白を打った）は黙って捨てる
    if (!value) continue;
    const neg = token.negated ? "-" : "";
    // Slack の書式（<@U…>・<#C…|名前>）を貼り付けたときは、そのまま使う
    if (/^<[@#][A-Z0-9]+(\|[^>]*)?>$/.test(value)) {
      parts.push(`${neg}${token.modifier}:${value}`);
      filters.push({
        modifier: token.modifier,
        negated: token.negated,
        label: value,
      });
      continue;
    }
    if (normalize(value) === SELF_TOKEN && token.modifier !== "in") {
      parts.push(
        token.modifier === "from" ? `${neg}from:me` : `${neg}to:<@${selfId}>`,
      );
      filters.push({
        modifier: token.modifier,
        negated: token.negated,
        label: "自分",
      });
      continue;
    }
    const found = findTarget(token, sources);
    if (!found) {
      unresolved.push(token);
      continue;
    }
    parts.push(
      token.modifier === "in" && !isDirectMessageFilter(token)
        ? `${neg}in:<#${found.id}>`
        : `${neg}${token.modifier}:<@${found.id}>`,
    );
    filters.push({
      modifier: token.modifier,
      negated: token.negated,
      label: found.title,
    });
  }
  return { query: parts.join(" "), filters, unresolved, completing };
}
