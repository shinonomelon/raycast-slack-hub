// 一覧の見せ方を決める純粋な関数：セクションの順、検索欄に足す絞り込みの文字、行の id、
// 操作のあとに先頭の行を選ぶ判断。@raycast/api を読み込まないので、node のテストから動かせる
import type { Hit } from "../../slack/hits.ts";
import type { Row } from "../../slack/items.ts";
import { completingToken, parseQuery } from "../search/query.ts";
import type { SearchStatus } from "../search/search-gate.ts";

// 一覧のセクション。候補は、絞り込み語の入力中だけ出る。
// 自分宛て（triage）は、検索欄が空のときだけ出て、メッセージ（検索結果）の代わりに会話と組になる
export type SectionName =
  "candidates" | "conversations" | "messages" | "triage";
// 先に出す順を入れ替える対象（候補は常に先頭なので入れ替えない）
export type OrderedSection = Exclude<SectionName, "candidates">;

// ---- セクションの順 ----------------------------------------------------------------

// 検索欄に絞り込み語（from:・to:・in:）があるか。否定（-in:）と入力中の語も数える。
// after: など、Slack がそのまま読む修飾子は数えない
export function hasFilterToken(text: string): boolean {
  return parseQuery(text).tokens.some((token) => token.type === "filter");
}

// 検索欄が空か。空のときは、メッセージの検索でなく、自分宛ての整理を出す
const isTriageText = (text: string): boolean => text.trim() === "";

// 会話と組になるセクション。検索欄が空なら自分宛て、空でなければメッセージ（検索結果）
const partnerOf = (text: string): "triage" | "messages" =>
  isTriageText(text) ? "triage" : "messages";

// 入れ替えが無いときに先に出すもの。検索欄が空なら自分宛て、絞り込み語を打てばメッセージ、名前を打てば会話
function defaultFirst(text: string): OrderedSection {
  if (isTriageText(text)) return "triage";
  return hasFilterToken(text) ? "messages" : "conversations";
}

const other = (section: OrderedSection, text: string): OrderedSection =>
  section === "conversations" ? partnerOf(text) : "conversations";

// 先に出すセクション。override は Shift+Tab で入れ替えたあとの順で、あればそれを使う。
// 会話でなければ、検索欄が空かどうかで、組になるほう（自分宛て・メッセージ）に決まる
// （古い入れ替えの印が残っていても、空欄の一覧にメッセージの検索結果が出ない）
export function firstSection(
  text: string,
  override: OrderedSection | undefined,
): OrderedSection {
  const section = override ?? defaultFirst(text);
  return section === "conversations" ? section : partnerOf(text);
}

// Shift+Tab を押したときの、入れ替えたあとの順。先に出ているほうを入れ替える。
// 入れ替えて元の順（入れ替え前の既定）に戻るときは、入れ替え中の印を持たない（undefined）
export function toggleOverride(
  text: string,
  override: OrderedSection | undefined,
): OrderedSection | undefined {
  const swapped = other(firstSection(text, override), text);
  return swapped === defaultFirst(text) ? undefined : swapped;
}

// 検索欄の文字が変わったあとの、入れ替えの印。
// - 検索欄が空になったら、入れ替えを解除する
// - 空欄から文字を打ち始めたときも解除する。空欄での入れ替え（会話を先にした）は、文字のある一覧では意味が違う
//   （そのまま持ち越すと、in: を足したのに、メッセージでなく会話が先になる）。previous は変える前の文字
// - 文字が残っているあいだは、絞り込み語が増えても保つ
//   （メッセージを先にしたまま in: を足したら、会話に戻らないように）
export function overrideAfterTextChange(
  text: string,
  override: OrderedSection | undefined,
  previous?: string,
): OrderedSection | undefined {
  if (isTriageText(text)) return undefined;
  if (previous !== undefined && isTriageText(previous)) return undefined;
  return override;
}

// 一覧に出すセクションの順。候補のセクション（候補と、相手が決まらない絞り込みの警告）があれば、いちばん上。
// 検索欄が空のときは、自分宛てと会話の2つだけ（メッセージの検索結果は出さない）
export function sectionOrder(
  text: string,
  override: OrderedSection | undefined,
  hasTopSection: boolean,
): SectionName[] {
  const first = firstSection(text, override);
  const second = other(first, text);
  return hasTopSection ? ["candidates", first, second] : [first, second];
}

// 会話の一覧を絞る語。検索欄の語から、絞り込み（from:・to:・in:）と after: などの修飾子を除いたもの。
// 引用符で囲んだ句は、囲みを外す
export function conversationQuery(text: string): string {
  return parseQuery(text)
    .tokens.filter((token) => token.type === "text")
    .map((token) => token.raw.replaceAll('"', ""))
    .join(" ")
    .trim();
}

// ---- 検索欄に足す絞り込み ------------------------------------------------------------

// 絞り込みを足す行の種類
export type FilterRow =
  // 会話・人の行。検索欄に打った名前でその行を探したので、その語は外して足す
  | "conversation"
  // メッセージの行。検索欄の語で見つけた結果なので、その語は残して足す
  | "message";

// 行の絞り込み（in:#名前・from:@名前 など）を足した検索欄の文字。足す前に、次の語を外す。
// - どの行でも：入力中の絞り込み語（空白で終わっていない最後の in:・from:・to:）。足す語が、その語の続きになるため
// - 会話・人の行では、さらに：検索の語（会話の一覧を探すのに使う語。その行を探すのに打った名前。引用符の句・-語も）。
//   残すと、その名前がメッセージの検索語として残り（例：example in:#example_remind）、その会話の新しいメッセージが出ない
// 確定した絞り込み語（from:・to:・in:）と after: などの修飾子は、元の順のまま残す。
// 残す語の中に、足す語と同じ語がもうあれば、足さずに残す語だけを並べる（Tab を続けて押しても、同じ語が重ならない）。
// 同じ語かは、検索欄の語そのもので見る（否定の -in:#名前 は、別の語）。
// 末尾に足す語を付け、末尾は空白で確定させる。語の間の空白は1つにそろう
export function textWithFilter(
  current: string,
  filter: string,
  row: FilterRow,
): string {
  const parsed = parseQuery(current);
  const completing = completingToken(parsed);
  const kept = parsed.tokens
    .filter((token) => token !== completing)
    .filter((token) => row === "message" || token.type !== "text")
    .map((token) => token.raw);
  const words = kept.includes(filter) ? kept : [...kept, filter];
  return `${words.join(" ")} `;
}

// 会話・人の ID から、検索欄の正式な語（#チャンネル名・@ハンドル）を引く。
// 検索式に直すときに見る候補元（toFilterSources）と同じものから引くので、足した語は必ず検索式に直せる
export type TokenOf = (id: string) => string | undefined;

// 会話・人の行で絞る語。会話は in:#名前、人は from:@名前、グループDM は in:<#ID>（名前にカンマと空白を含むため ID）。
// 候補元に無いもの（削除済みの人・一覧に無いチャンネル）は、Slack の書式の ID でそのまま足す
export function filterForRow(
  row: Pick<Row, "id" | "kind">,
  tokenOf: TokenOf,
): string {
  switch (row.kind) {
    case "person":
      return `from:${tokenOf(row.id) ?? `<@${row.id}>`}`;
    case "group":
      return `in:<#${row.id}>`;
    case "channel":
    case "private":
      return `in:${tokenOf(row.id) ?? `<#${row.id}>`}`;
  }
}

// メッセージの行の会話で絞る語。チャンネルは in:#名前、DM は in:@相手（相手が候補元に無ければ in:<@U…>）、
// グループDM は in:<#ID>。DM の相手は channel.name に入っているユーザー ID で、分からなければ絞れない（undefined）
export function filterForHitConversation(
  hit: Pick<Hit, "channelId" | "channelKind" | "channelName">,
  tokenOf: TokenOf,
): string | undefined {
  switch (hit.channelKind) {
    case "channel":
    case "private":
      return `in:${tokenOf(hit.channelId) ?? `<#${hit.channelId}>`}`;
    case "im":
      return hit.channelName
        ? `in:${tokenOf(hit.channelName) ?? `<@${hit.channelName}>`}`
        : undefined;
    case "mpim":
      return `in:<#${hit.channelId}>`;
  }
}

// メッセージの行の送信者で絞る語。送信者の ID が無い bot の投稿は絞れない（undefined）
export function filterForSender(
  hit: Pick<Hit, "userId">,
  tokenOf: TokenOf,
): string | undefined {
  return hit.userId
    ? `from:${tokenOf(hit.userId) ?? `<@${hit.userId}>`}`
    : undefined;
}

// ---- 行の id --------------------------------------------------------------------------

// 一覧の全行に付ける id。セクションをまたいで重複しないよう、行の種類を前置きにする。
// 候補は、自分（me）と同じ人（自分の ID）が並ぶことがあるので、ID でなく検索欄に書く語で区別する
export const candidateRowId = (c: {
  negated: boolean;
  modifier: string;
  token: string;
}) => `cand:${c.negated ? "-" : ""}${c.modifier}:${c.token}`;

export const conversationRowId = (row: Pick<Row, "id" | "kind">) =>
  row.kind === "person" ? `person:${row.id}` : `conv:${row.id}`;

export const messageRowId = (hit: Pick<Hit, "key">) => `msg:${hit.key}`;

// 空欄の一覧の自分宛ての行。検索結果のメッセージの行と、同じメッセージでも id が重ならない
export const triageRowId = (hit: Pick<Hit, "key">) => `tome:${hit.key}`;

// 相手が決まらない絞り込み語の警告の行（検索欄の中の位置で区別する）
export const warningRowId = (start: number) => `warn:${start}`;

// メッセージの検索が止まっている・失敗した行
export const STATUS_ROW_ID = "status:messages";

// ---- どの行にも置く共通の操作の並び ----------------------------------------------------

// どの行にも、一覧が空のとき（EmptyView）にも置く3つの操作。
// swap は Shift+Tab（並びの入れ替え）、reload-search は ⌘R（検索の取り直し）、reload-all は ⌘⇧R（一覧全体の取り直し）
export type CommonAction = "swap" | "reload-search" | "reload-all";

// 行に固有の操作がある行（会話・人・メッセージ・候補）では、↵ はその行の操作（Slackで開く・候補を確定）に使われるので、
// 共通の3つは行の操作のあとに、この順で置く
export const COMMON_ACTIONS: readonly CommonAction[] = [
  "swap",
  "reload-search",
  "reload-all",
];

// 共通の3つだけを持つ行
export type StandaloneRow =
  // メッセージの検索が止まっている・失敗した行
  | "search-status"
  // 相手が決まらない絞り込みの警告の行
  | "unresolved-filter"
  // 一覧が空のとき
  | "empty";

// 共通の3つだけを持つ行の並び。この行では1番目の操作を ↵ が押すので、並びの入れ替え（Shift+Tab）が
// ↵ で動いてしまわないよう、その行が知らせている問題を直す取り直しを先頭にする。
// 3つとも残す（Shift+Tab・⌘R・⌘⇧R は、どの行にも置く）。同じ操作を2つ置くとショートカットが重なるので、順を替えるだけにする
export function standaloneActions(row: StandaloneRow): readonly CommonAction[] {
  switch (row) {
    case "search-status":
      // 止まった・失敗した検索を取り直す
      return ["reload-search", "swap", "reload-all"];
    case "unresolved-filter":
      // 新しいチャンネル・人が一覧に入れば、相手が決まる
      return ["reload-all", "swap", "reload-search"];
    case "empty":
      // 段①と同じ、一覧全体の取り直し
      return ["reload-all", "swap", "reload-search"];
  }
}

// ---- 操作のあとに先頭の行を選ぶ ------------------------------------------------------

// 先頭の行を選ぶのは、利用者の操作（Shift+Tab・Tab・⌘F・候補の確定）の直後に1回だけにする。
// 選択が勝手に動くと、↵ や ⌘↵ が別のメッセージに効いてしまうため、裏の取り直しや並べ替えでは選び直さない。
// 操作のときに予約を作り、選べたとき・捨てるときに使い終える（decideSelection の next が undefined になる）
export type SelectionRequest = {
  // 予約したときの検索欄。待っている間に変わったら、予約を捨てる
  text: string;
  // 先頭を選ぶセクション
  section: SectionName;
};

// 操作の直後の予約を作る。text は操作のあとの検索欄。候補があるときは、いちばん上の候補を選ぶ
export function requestFirstRow(
  text: string,
  override: OrderedSection | undefined,
  hasCandidates: boolean,
): SelectionRequest {
  return {
    text,
    section: hasCandidates ? "candidates" : firstSection(text, override),
  };
}

// 検索欄の文字が変わったあとの、入れ替えの印と、先頭の行を選ぶ予約。
// 文字を変えた直後（打った・Tab で足した・候補を確定した）も、利用者の操作の直後なので、先頭の行を選ぶ。
// 選ばないと、メッセージが先のとき、打った直後は結果がまだ無く、Raycast は先頭の会話の行を選ぶ。
// 結果が届いても選択は会話の行に残り、メッセージの行の操作（↵ で Slack を開く、⌘↵ で詳細、⌘⇧↵ で返信）でなく、
// 会話の行の操作（↵ で会話を開く、⌘↵ で会話の詳細、⌘N で投稿）が効いてしまう
// （in:#example_remind のあとに good と打つと起きた）。結果が届いたときに、先頭のメッセージの行を選ぶ。
// 待っている間にまた打ったら、予約は新しい文字の分に作り直す（decideSelection は、文字が変わった予約を捨てる）。
// 予約に使う入れ替えの印は、文字を変えたあとのもの（検索欄を空にしたら解除されたあと）。
// hasCandidates は、変えたあとの文字に、入力中の絞り込み語の候補があるか（あれば、いちばん上の候補を選ぶ）。
// previous は、変える前の文字（空欄から打ち始めたときに、空欄での入れ替えを持ち越さないため）
export function afterTextChange(
  text: string,
  override: OrderedSection | undefined,
  hasCandidates: boolean,
  previous?: string,
): { override: OrderedSection | undefined; request: SelectionRequest } {
  const next = overrideAfterTextChange(text, override, previous);
  return {
    override: next,
    request: requestFirstRow(text, next, hasCandidates),
  };
}

export type SelectionView = {
  // いまの検索欄
  text: string;
  // いまの検索欄に resolveQuery を通した検索式。in:#名前 は検索式では in:<#C…> になるので、
  // 検索欄の文字そのものではなく、検索式で比べる
  query: string;
  // メッセージの検索の状態（フックが返す、結果を出した検索式と、直近の判断・結果）
  search: {
    query: string | undefined;
    status: SearchStatus | undefined;
  };
  // 各セクションの先頭の行の id。行が無い・渡していないセクションは undefined
  firstIds: Partial<Record<SectionName, string | undefined>>;
};

export type SelectionDecision = {
  // selectedItemId に渡す id。選ばないとき（待っている・捨てた・予約が無い・選ぶ行が無い）は undefined
  selectedId: string | undefined;
  // 次の予約。まだ待つなら同じ予約、使い終えた・捨てたなら undefined。画面は、これを予約として持ち直す
  next: SelectionRequest | undefined;
};

const DONE: SelectionDecision = { selectedId: undefined, next: undefined };

// 予約をどうするか決める。
// - 予約が無ければ、何もしない（行が入れ替わっても選ばない）
// - 予約したあとに検索欄が変わっていたら、捨てる
// - 候補・会話・自分宛ては、検索欄だけで決まる（メッセージの検索結果を待たない）ので、すぐ先頭の行を選ぶ
// - メッセージは、いまの検索語の結果が出てから選ぶ。出るまでは待つ。
//   いまの検索語が失敗・停止・検索しない判断になったときは、結果が来ないので捨てる
export function decideSelection(
  request: SelectionRequest | undefined,
  view: SelectionView,
): SelectionDecision {
  if (!request) return DONE;
  if (request.text !== view.text) return DONE;
  if (request.section !== "messages") {
    return { selectedId: view.firstIds[request.section], next: undefined };
  }

  const { query, status } = view.search;
  // いまの検索式について、結果が来ないと分かった（古い検索式の記録は、まだ関係ない）
  if (status && status.query === view.query && status.kind !== "ok") {
    return DONE;
  }
  // いまの検索語の結果が出ている
  if (query === view.query) {
    return { selectedId: view.firstIds.messages, next: undefined };
  }
  return { selectedId: undefined, next: request };
}
