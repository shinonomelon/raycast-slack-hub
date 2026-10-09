// 会話の行に出す未読タグの件数を決める純粋な部品。@raycast/api を読み込まないので、node のテストから動かせる。
// 数えるのは、Slack の既読位置より新しい最上位の投稿だけ（スレッド返信と自分の投稿は数えない）。
// 対応済みの印（開いた・対応済み）はタグに効かせない。タグは Slack の既読位置だけで決まり、Slack で読めば消える
import { compareTs, isThreadReply, type Hit } from "../../slack/hits.ts";
import { isCountUnknown, type FavoriteUnread } from "./triage.ts";

// 行の id ごとの未読。atLeast は件数が下限（「3+」）。未読が無い行は持たない
export type UnreadTag = { count: number; atLeast: boolean };

// タグの文字。下限のときは「3+」
export function formatTag(tag: UnreadTag): string {
  return `${tag.count}${tag.atLeast ? "+" : ""}`;
}

type MineHit = Pick<
  Hit,
  "channelId" | "channelKind" | "channelName" | "ts" | "threadTs" | "userId"
>;

// 自分宛てのメッセージが付く行の id。DM は相手の人の行（相手のユーザー ID。DM の channel.name に入っている）、
// それ以外は会話の行（会話 ID）。DM の相手が分からないときは undefined
function rowIdOf(hit: MineHit): string | undefined {
  return hit.channelKind === "im" ? hit.channelName : hit.channelId;
}

// 行を開いたとき、未読を消す会話の ID。人の行は、その人との DM の会話（DM の相手は channel.name に入っている
// ユーザー ID で、タグを付けるときの対応と同じ）。それ以外の行は、会話そのもの。
// 人の行で、その人との DM が自分宛ての中に無ければ、タグも付いていないので空
export function conversationsOfRow(
  row: { id: string; isPerson: boolean },
  mine: readonly MineHit[],
): string[] {
  if (!row.isPerson) return [row.id];
  return [
    ...new Set(
      mine
        .filter((hit) => hit.channelKind === "im" && rowIdOf(hit) === row.id)
        .map((hit) => hit.channelId),
    ),
  ];
}

// 行の id（会話 ID。DM は相手のユーザー ID）ごとの未読タグを作る。
// - お気に入りのまとめ検索の結果で件数が分かる会話（favoriteResultIds のうち、件数不明でないもの）には、
//   その検索で数えた件数だけを使う。その件数にはその会話の自分宛ての投稿も入っているので、
//   自分宛ての件数は足さない（二重に数えない）
// - それ以外の会話と、DM の相手の人の行には、自分宛ての未読の件数を使う。
//   お気に入りの会話も、次の間はここに入る。件数が分かる結果（個別の確かめを含む）が来たら置き換わる：
//   まとめ検索の結果が来るまで（取得中・停止・失敗）／結果が件数不明（件数 0 で下限。isCountUnknown）の間
// - 件数が下限のときは atLeast になる：
//   お気に入りの件数は、検索が上限で切れた・既読位置が検索した期間より古いとき。
//   自分宛ての件数は、既読位置が mineFrom より前のとき（既読位置から先の一部が、自分宛ての結果に入っていない）。
//   件数不明のお気に入りの自分宛ての件数も下限：お気に入りの未読は、自分宛て以外の投稿も入れて、これ以上ある
// lastReads は会話 ID → 既読位置（取れたものだけ）。既読位置が無い会話は、未読か分からないので数えない
export function unreadTags(params: {
  mine: readonly MineHit[];
  lastReads: ReadonlyMap<string, string>;
  favorites: readonly FavoriteUnread[];
  // お気に入りのまとめ検索の結果がある会話の ID（結果で 0 件だった会話も含む）。triage.ts の favoritesWithResult。
  // 件数不明の会話が含まれていても、favorites に件数不明で載っていれば、結果が無いのと同じに扱う
  favoriteResultIds: ReadonlySet<string>;
  // 自分宛ての結果が揃っている期間の始まり。triage.ts の mineCompleteFrom
  mineFrom: string;
  selfId: string;
}): Map<string, UnreadTag> {
  const { mine, lastReads, favorites, favoriteResultIds, mineFrom, selfId } =
    params;
  const tags = new Map<string, UnreadTag>();

  // 件数不明のお気に入り。結果が無いのと同じに、自分宛ての件数で出し、下限にする
  const unknownCounts = new Set(
    favorites.filter(isCountUnknown).map((favorite) => favorite.channelId),
  );
  // お気に入りの結果で件数が分かる会話
  const countKnown = new Set(
    [...favoriteResultIds].filter((id) => !unknownCounts.has(id)),
  );

  for (const favorite of favorites) {
    if (!countKnown.has(favorite.channelId) || favorite.count <= 0) continue;
    tags.set(favorite.channelId, {
      count: favorite.count,
      atLeast: favorite.truncated,
    });
  }

  for (const hit of mine) {
    // お気に入りの結果で件数が分かる会話は、お気に入りの件数がすべて
    if (hit.channelKind !== "im" && countKnown.has(hit.channelId)) continue;
    if (isThreadReply(hit) || hit.userId === selfId) continue;
    const lastRead = lastReads.get(hit.channelId);
    if (lastRead === undefined || compareTs(hit.ts, lastRead) <= 0) continue;
    const rowId = rowIdOf(hit);
    if (rowId === undefined) continue;
    // 既読位置が mineFrom より前なら、既読位置から mineFrom までの間の未読は、自分宛ての結果に入っていない
    // （ちょうど同じなら、既読位置より新しい投稿はすべて入っている）。件数不明のお気に入りも下限
    const atLeast =
      unknownCounts.has(hit.channelId) || compareTs(lastRead, mineFrom) < 0;
    const tag = tags.get(rowId);
    if (tag) {
      tag.count += 1;
      if (atLeast) tag.atLeast = true;
    } else tags.set(rowId, { count: 1, atLeast });
  }
  return tags;
}
