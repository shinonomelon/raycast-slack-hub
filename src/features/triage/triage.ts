// 自分宛ての整理（既読の判定・印・既読位置の取り直し・お気に入りの未読）の判断。
// @raycast/api を読み込まない純粋な部品で、node のテストから動かせる。
// 保存（read-state.ts）と取得（use-triage.ts）は、この部品の判断に従う
import { compareTs, isThreadReply, type Hit } from "../../slack/hits.ts";
import {
  LAST_READ_TIMEOUT_MS,
  type GateKind,
  type Pause,
} from "../search/search-gate.ts";
import type { LastReadRow } from "../../shared/types.ts";

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

// ---- 整理の値 ----------------------------------------------------------------------
// 保存や取り直しの判断に使う値。read-state.ts は node のテストから読めないので、テストで確かめる値はここに置く

// 自分宛てを整理する期間（日）
export const TRIAGE_DAYS = 7;
// 前回の整理の結果をすぐ出し、これより古ければ取り直す
export const TRIAGE_MAX_AGE_MS = 60_000;
// 既読位置の取り直し。Open Channel の裏の取得と回数制限の枠を分け合うので、1回に取り直すのは20会話まで。
// 3分以内に取ったものは飛ばす。取れなかった会話（null）は変わりにくいので、60分持つ
export const LAST_READ_BUDGET = 20;
export const LAST_READ_OPTIONS = {
  ttlMs: 3 * 60_000,
  nullTtlMs: 60 * 60_000,
  budget: LAST_READ_BUDGET,
};
// 既読位置は数分で古くなるが、取り直せなかったときの代わりに1日だけ持つ。
// 既読位置は進むだけなので、古い値で判定しても既読を未読と見誤る側にしか外れない
export const LAST_READ_KEEP_MS = DAY_MS;
// 印（開いた・対応済み）を持つ期間。整理は過去7日なので、それより長く持つ
export const MARK_TTL_MS = 14 * DAY_MS;
// お気に入りは10会話ずつまとめて検索し、まとめ検索は1回5つ（50会話）まで。
// 件数不明の会話を個別に確かめるのは1回3件まで
export const FAVORITE_CHUNK = 10;
export const FAVORITE_CHUNKS_MAX = 5;
export const UNKNOWN_CHECKS = 3;
// 個別に確かめた結果を持つ期間。まとめ検索が上限で切れると新着が個別の結果を待つことになるので、長くは持たない
export const CHECK_KEEP_MS = 10 * 60 * 1000;

// Slack の after: は日付単位で、その日自体を含まない。境目の取りこぼしを避けるため1日多くさかのぼり、
// 正確な期間は sinceTs で絞る。日付は利用者の環境のローカル時刻で数える
export function searchAfterDate(now: Date, days: number): string {
  const d = new Date(now.getTime() - (days + 1) * DAY_SECONDS * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 期間の始まりを Slack の ts の形で返す
export function sinceTs(now: Date, days: number): string {
  return `${Math.floor(now.getTime() / 1000) - days * DAY_SECONDS}.000000`;
}

// 複数の検索結果を、同じメッセージは1件にまとめて新しい順に並べる
export function mergeHits(lists: readonly (readonly Hit[])[]): Hit[] {
  const byKey = new Map<string, Hit>();
  for (const list of lists) {
    for (const hit of list) {
      if (!byKey.has(hit.key)) byKey.set(hit.key, hit);
    }
  }
  return [...byKey.values()].sort((a, b) => compareTs(b.ts, a.ts));
}

// 切れたのに1件も取れていないとき、どこまで揃っているか分からない。どの既読位置よりも後ろの ts を境目にして、
// すべての会話の件数を下限にする
export const NOTHING_COMPLETE_TS = "9999999999.999999";

// 自分宛ての検索（メンションと to: の2つ）が件数の上限で切れたときの境目。検索は新しい順なので、切れた検索で
// 揃っているのは、取れた中で一番古い投稿より新しい側だけで、古い側は取れていない。
// 切れた検索ごとに「取れた一番古い投稿の ts」を出し、そのうち一番新しいものを返す（どちらの古い側も欠けるため）。
// 切れた検索が無ければ undefined
export function cappedBeforeOf(
  searches: readonly { hits: readonly Pick<Hit, "ts">[]; capped: boolean }[],
): string | undefined {
  let before: string | undefined;
  for (const search of searches) {
    if (!search.capped) continue;
    const edge = oldestTs(search.hits) ?? NOTHING_COMPLETE_TS;
    if (before === undefined || compareTs(edge, before) > 0) before = edge;
  }
  return before;
}

// 自分宛ての結果が揃っている期間の始まり：期間の始まり（since）と、検索が切れた境目（cappedBefore）のうち新しいほう。
// この ts より前に既読位置がある会話の、自分宛ての件数は下限になる（既読位置から先の一部が、結果に入っていない）。
// ちょうど同じなら、既読位置より新しい投稿はすべて入っているので、下限ではない
export function mineCompleteFrom(
  since: string,
  cappedBefore: string | undefined,
): string {
  return cappedBefore !== undefined && compareTs(cappedBefore, since) > 0
    ? cappedBefore
    : since;
}

export type ReadState = "unread" | "read" | "thread" | "unknown" | "handled";

// 既読の判定。チャンネルの既読位置（last_read）より新しければ未読。
// スレッド返信は、チャンネルの既読位置にスレッドの既読が反映されないので判定しない。
// last_read が null は、取れなかった（参加していないなど）、undefined はまだ取っていない
export function judgeReadState(
  hit: Hit,
  lastRead: string | null | undefined,
  handled: ReadonlySet<string>,
): ReadState {
  if (handled.has(hit.key)) return "handled";
  if (isThreadReply(hit)) return "thread";
  if (lastRead === undefined || lastRead === null) return "unknown";
  return compareTs(hit.ts, lastRead) > 0 ? "unread" : "read";
}

export type View = "all" | "unread" | "mine";

// 「未読のみ」には、判定できないもの（スレッド・未確認）も残す。取りこぼすより、余計に出るほうがよいため
export function matchesView(hit: Hit, state: ReadState, view: View): boolean {
  if (view === "unread") {
    return state === "unread" || state === "thread" || state === "unknown";
  }
  if (view === "mine") {
    return (
      hit.mentionsSelf || hit.channelKind === "im" || hit.channelKind === "mpim"
    );
  }
  return true;
}

// 「開いた」「対応済み」の印（キー → 付けた時刻）のうち、期限内のものだけ残す
export function pruneMarks(
  marks: Readonly<Record<string, number>>,
  now: number,
  ttlMs: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(marks).filter(([, at]) => now - at <= ttlMs),
  );
}

export type CachedLastRead = { lastRead: string | null; at: number };

// 既読位置を取り直す会話を選ぶ。新しい順の重複なし、新鮮なものは飛ばし、上限で切る。
// 取れなかった会話（null）は変わりにくいので、長く持つ
// force は ⌘R のとき：キャッシュの新しさに関わらず取り直す（重複を除くことと上限は、そのまま守る）
export function planRefresh(
  wanted: readonly string[],
  cached: ReadonlyMap<string, CachedLastRead>,
  now: number,
  options: {
    ttlMs: number;
    nullTtlMs: number;
    budget: number;
    force?: boolean;
  },
): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = cached.get(id);
    const ttl = entry?.lastRead === null ? options.nullTtlMs : options.ttlMs;
    if (!options.force && entry && now - entry.at <= ttl) continue;
    picked.push(id);
    if (picked.length >= options.budget) break;
  }
  return picked;
}

// 取れた投稿のうち一番古いものの ts。1件も無ければ undefined
function oldestTs(hits: readonly Pick<Hit, "ts">[]): string | undefined {
  let oldest: string | undefined;
  for (const hit of hits) {
    if (!oldest || compareTs(hit.ts, oldest) < 0) oldest = hit.ts;
  }
  return oldest;
}

// まとめて検索した結果が件数の上限で切れたとき、取れた中で一番古い投稿より前に既読位置がある会話を返す。
// その会話は、取れなかった古い側にも未読があるかもしれないので、件数が下限になる
export function truncatedByCap(
  ids: readonly string[],
  lastReadById: ReadonlyMap<string, string>,
  hits: readonly Pick<Hit, "ts">[],
): Set<string> {
  const oldest = oldestTs(hits);
  return new Set(
    ids.filter((id) => {
      const lastRead = lastReadById.get(id);
      return (
        lastRead !== undefined &&
        (oldest === undefined || compareTs(lastRead, oldest) < 0)
      );
    }),
  );
}

export type FavoriteUnread = {
  channelId: string;
  count: number;
  latestTs?: string;
  // 検索の件数の上限で切れた、または既読位置が検索した期間より古い。件数は下限で、0 なら未読があるかも不明
  truncated: boolean;
};

// 件数不明（件数 0 で下限）。未読があるかも、いくつあるかも分からない。個別の確かめの対象で、
// 確かめた結果が来るまでは、数える側（unreadTags）は結果が無いのと同じに扱う
export const isCountUnknown = (
  favorite: Pick<FavoriteUnread, "count" | "truncated">,
): boolean => favorite.count <= 0 && favorite.truncated;

// お気に入りの未読を数えるのに要る項目だけ（会話・ts・スレッドの親・送信者）。
// 数えるだけなので、本文と permalink は持たない（Raycast の Cache は平文で保存されるため）
export type FavoriteHit = Pick<Hit, "channelId" | "ts" | "threadTs" | "userId">;

// お気に入りの会話ごとの未読数。スレッド返信と自分の投稿は数えない。
// 既読位置が検索した期間より古い会話は、期間内に未読が無くても捨てずに残す（既読位置と期間の間に未読があるかもしれない）
export function summarizeFavoriteUnread(
  hits: readonly FavoriteHit[],
  lastReadById: ReadonlyMap<string, string>,
  selfId: string,
  options: { truncatedIds: ReadonlySet<string>; horizonTs: string },
): FavoriteUnread[] {
  const byChannel = new Map<string, FavoriteUnread>();
  for (const [channelId, lastRead] of lastReadById) {
    byChannel.set(channelId, {
      channelId,
      count: 0,
      truncated:
        options.truncatedIds.has(channelId) ||
        compareTs(lastRead, options.horizonTs) < 0,
    });
  }
  for (const hit of hits) {
    const entry = byChannel.get(hit.channelId);
    const lastRead = lastReadById.get(hit.channelId);
    if (!entry || lastRead === undefined) continue;
    if (isThreadReply(hit) || hit.userId === selfId) continue;
    if (compareTs(hit.ts, lastRead) <= 0) continue;
    entry.count += 1;
    if (!entry.latestTs || compareTs(hit.ts, entry.latestTs) > 0) {
      entry.latestTs = hit.ts;
    }
  }
  return [...byChannel.values()]
    .filter((f) => f.count > 0 || f.truncated)
    .sort((a, b) => compareTs(b.latestTs ?? "0", a.latestTs ?? "0"));
}

// ---- 印（開いた・対応済み）の付け外し ---------------------------------------------------

// 印のあるメッセージの key → 付けた時刻
export type Marks = Readonly<Record<string, number>>;

// 印を付ける。期限（14日）を過ぎた印は、このとき消える
export function markHandled(
  marks: Marks,
  key: string,
  now: number,
): Record<string, number> {
  return { ...pruneMarks(marks, now, MARK_TTL_MS), [key]: now };
}

// 印を外す。期限を過ぎた印は、このとき消える
export function unmarkHandled(
  marks: Marks,
  key: string,
  now: number,
): Record<string, number> {
  const kept = pruneMarks(marks, now, MARK_TTL_MS);
  delete kept[key];
  return kept;
}

// 印が無ければ付け、あれば外す（⌘⇧D）
export function toggleHandled(
  marks: Marks,
  key: string,
  now: number,
): Record<string, number> {
  return Object.hasOwn(pruneMarks(marks, now, MARK_TTL_MS), key)
    ? unmarkHandled(marks, key, now)
    : markHandled(marks, key, now);
}

// 判定に使う、印のあるメッセージの key（期限を過ぎたものは含めない）
export function handledKeys(marks: Marks, now: number): Set<string> {
  return new Set(Object.keys(pruneMarks(marks, now, MARK_TTL_MS)));
}

// ---- 既読位置の取得結果から、保存するものと止める期限を決める --------------------------------

export type LastReadStore = {
  // 保存する既読位置（会話 ID → 値）。取れなかった会話は、保存しないか、null で保存する
  save: Map<string, CachedLastRead>;
  // 回数制限が出たとき、既読位置の取得を止める期限。止めるのは gate の last-read だけで、検索（search）は止めない
  pause?: { gate: GateKind; pause: Pause };
};

// 会話ごとの既読位置取得 の結果（会話ごと・理由つき）から、保存するものを決める。
// - 取れた：値を保存する
// - no_last_read（参加していないなど）・not_visible（会話が見えない）：null で保存する。変わりにくいので60分持つ（planRefresh の nullTtlMs）
// - rate_limited：保存しない。retryAfter の秒数だけ、既読位置の取得を止める（複数あれば、いちばん長いもの）
// - error・知らない理由・待つ秒数の無い rate_limited：保存しない。止めず、次に取り直す
export function decideLastReadStore(
  rows: readonly LastReadRow[],
  now: number,
): LastReadStore {
  const save = new Map<string, CachedLastRead>();
  let retryAfterSeconds = 0;
  for (const row of rows) {
    if (row.reason === null) {
      // 取れたときは lastRead が入る。入っていなければ、読めない行として保存しない
      if (typeof row.lastRead === "string") {
        save.set(row.channelId, { lastRead: row.lastRead, at: now });
      }
      continue;
    }
    if (row.reason === "no_last_read" || row.reason === "not_visible") {
      save.set(row.channelId, { lastRead: null, at: now });
      continue;
    }
    if (
      row.reason === "rate_limited" &&
      typeof row.retryAfter === "number" &&
      Number.isFinite(row.retryAfter) &&
      row.retryAfter > 0
    ) {
      retryAfterSeconds = Math.max(retryAfterSeconds, row.retryAfter);
    }
  }
  return retryAfterSeconds > 0
    ? {
        save,
        pause: {
          gate: "last-read",
          pause: {
            until: now + retryAfterSeconds * 1000,
            cause: "rate_limited",
          },
        },
      }
    : { save };
}

// 保存してある既読位置のうち、持つ期間（1日）を過ぎていないものだけ残す
export function pruneLastReads(
  entries: ReadonlyMap<string, CachedLastRead>,
  now: number,
): Map<string, CachedLastRead> {
  return new Map(
    [...entries].filter(([, entry]) => now - entry.at <= LAST_READ_KEEP_MS),
  );
}

// 既読位置が取れている会話だけの、会話 ID → 既読位置
export function lastReadMap(
  entries: ReadonlyMap<string, CachedLastRead>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, entry] of entries) {
    if (entry.lastRead !== null) map.set(id, entry.lastRead);
  }
  return map;
}

// 既読位置の取得の結果のうち、保存してよいもの。問い合わせを始めたあとに既読位置を忘れた会話
// （行を開いて、Slack の既読位置が進んだ）は、開く前の Slack の値かもしれない。保存すると、新しく取った値として
// 3分持たれ、取り直されないので、その回の結果では保存しない（次に取り直す）。
// forgottenAt は会話 ID ごとの、既読位置を忘れた時刻（ミリ秒）。忘れていなければ undefined。
// 問い合わせを始めたのと同じ時刻に忘れたものは、どちらが先か分からないので、保存しない側に倒す
export function keepFetchedLastReads(
  save: ReadonlyMap<string, CachedLastRead>,
  forgottenAt: (channelId: string) => number | undefined,
  requestedAt: number,
): Map<string, CachedLastRead> {
  return new Map(
    [...save].filter(([id]) => {
      const forgotten = forgottenAt(id);
      return forgotten === undefined || forgotten < requestedAt;
    }),
  );
}

// ---- 開いた会話（未読タグをすぐ消す） ------------------------------------------------------

// 会話の行を開いた時刻。会話 ID → Slack の ts の形（秒.マイクロ秒）。保存するのは ID と ts だけで、本文は持たない。
// 開いた会話の未読タグは、既読位置を Slack から取り直すまで、開いた時刻までは既読として数える（Open Channel と同じ動き）
export type Opened = Readonly<Record<string, string>>;

// ミリ秒の時刻を、Slack の ts の形にする
export function tsOfTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const micro = Math.floor((ms - sec * 1000) * 1000);
  return `${sec}.${String(micro).padStart(6, "0")}`;
}

// Slack の ts の形を、ミリ秒の時刻にする
function timeOfTs(ts: string): number {
  const [sec = "0", frac = ""] = ts.split(".");
  return Number(sec) * 1000 + Math.floor(Number(frac.padEnd(6, "0")) / 1000);
}

// 会話を開いた時刻を記録する。同じ会話を開き直したら、新しい時刻にする。渡した記録は変えない
export function openConversations(
  opened: Opened,
  ids: readonly string[],
  now: number,
): Opened {
  if (ids.length === 0) return opened;
  const ts = tsOfTime(now);
  return { ...opened, ...Object.fromEntries(ids.map((id) => [id, ts])) };
}

// 持つ期間（既読位置の保存と同じ1日）を過ぎた記録を落とす
export function pruneOpened(opened: Opened, now: number): Opened {
  return Object.fromEntries(
    Object.entries(opened).filter(
      ([, ts]) => now - timeOfTs(ts) <= LAST_READ_KEEP_MS,
    ),
  );
}

// 既読位置を、会話を開いたあとに Slack から取り直したか。保存した取得の時刻（at）は取り終えた時刻で、
// 問い合わせには最大 LAST_READ_TIMEOUT_MS かかる。開いた時刻からその時間以内に取り終えた値は、
// 開く前に問い合わせを始めた（開く前の Slack の状態の）値かもしれないので、取り直した値と見なさない
// （見なすと、開いた直後に終わった取り直しで、開いた会話のタグが戻る）
const refetchedAfterOpen = (entry: CachedLastRead, openedTs: string) =>
  entry.at - LAST_READ_TIMEOUT_MS > timeOfTs(openedTs);

// 未読タグを数えるための既読位置（会話 ID → 既読位置）。lastReadMap に、開いた会話の分を反映する。
// - 開いた会話は、開いた時刻までを既読として数える（開いたあとに届いた投稿は数える）
// - 開いたあとに Slack から取り直した値があれば、その値で数え直す（Slack で読んでいなければ、タグは戻る）
// - 既読位置が分からない会話は、開いても数え始めない（未読かどうかが分からないため）
// 空欄の一覧の自分宛ての行の判定（judgeReadState）には使わない（行の扱いは、会話を開いても変えない）
export function lastReadsForTags(
  entries: ReadonlyMap<string, CachedLastRead>,
  opened: Opened,
): Map<string, string> {
  const map = lastReadMap(entries);
  for (const [id, openedTs] of Object.entries(opened)) {
    const entry = entries.get(id);
    const lastRead = map.get(id);
    if (!entry || lastRead === undefined) continue;
    if (refetchedAfterOpen(entry, openedTs)) continue;
    if (compareTs(openedTs, lastRead) > 0) map.set(id, openedTs);
  }
  return map;
}

// ---- 検索式と、取る会話の決め方 ------------------------------------------------------

// 自分宛ての検索式。メンションの検索には自分の投稿が混ざるので -from:me で除く。
// 1つ目は <@自分>（メンション）、2つ目は to:<@自分>（DM・グループDM）
export function mentionQueries(selfId: string, after: string): string[] {
  return [
    `<@${selfId}> -from:me after:${after}`,
    `to:<@${selfId}> -from:me after:${after}`,
  ];
}

// お気に入りをまとめて検索する式。複数の in: は「どれかの会話」になる（2026年10月4日に確認）
export function favoriteSearchQuery(
  ids: readonly string[],
  after: string,
): string {
  return `${ids.map((id) => `in:<#${id}>`).join(" ")} after:${after}`;
}

// 件数不明の会話を個別に確かめる式。既読位置の日から検索する（古い順に取る）
export function unknownCheckQuery(id: string, lastRead: string): string {
  const day = new Date(Number(lastRead.split(".")[0]) * 1000);
  return `in:<#${id}> after:${searchAfterDate(day, 0)}`;
}

// お気に入りの組み分け。10会話ずつ、5つ（50会話）まで。それより後のお気に入りは検索しない（回数制限の枠を守るため）。
// 重複は除く
export function chunkFavorites(
  ids: readonly string[],
  size = FAVORITE_CHUNK,
  maxChunks = FAVORITE_CHUNKS_MAX,
): string[][] {
  const unique = [...new Set(ids)].slice(0, size * maxChunks);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}

// 既読位置を取り直したい会話。お気に入りを先に、そのあとに自分宛ての会話を新しい順に並べる（重複は除く）
export function wantedConversations(
  favoriteIds: readonly string[],
  hits: readonly Pick<Hit, "channelId">[],
): string[] {
  return [...new Set([...favoriteIds, ...hits.map((h) => h.channelId)])];
}

// ---- お気に入りの未読 ------------------------------------------------------------

// お気に入りを10会話ずつまとめて検索した結果。capped は件数の上限で切れたか
export type FavoriteChunk = {
  ids: string[];
  hits: FavoriteHit[];
  capped: boolean;
};

// 検索結果の1件を、数えるのに要る項目だけにする
export function toFavoriteHit(hit: Hit): FavoriteHit {
  return {
    channelId: hit.channelId,
    ts: hit.ts,
    ...(hit.threadTs !== undefined && { threadTs: hit.threadTs }),
    ...(hit.userId !== undefined && { userId: hit.userId }),
  };
}

// まとめ検索の結果と既読位置から、お気に入りの会話ごとの未読数を出す。
// 件数の上限で切れた検索の会話は、件数が下限になる（truncatedByCap）。
// lastReads は会話 ID → 既読位置。お気に入り以外の会話は使わない
export function summarizeFavorites(params: {
  chunks: readonly FavoriteChunk[];
  favoriteIds: readonly string[];
  lastReads: ReadonlyMap<string, string>;
  selfId: string;
  horizonTs: string;
}): FavoriteUnread[] {
  const { chunks, favoriteIds, lastReads, selfId, horizonTs } = params;
  const lastReadById = new Map<string, string>();
  for (const id of favoriteIds) {
    const lastRead = lastReads.get(id);
    if (lastRead !== undefined) lastReadById.set(id, lastRead);
  }
  const truncatedIds = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk.capped) continue;
    for (const id of truncatedByCap(chunk.ids, lastReadById, chunk.hits)) {
      truncatedIds.add(id);
    }
  }
  return summarizeFavoriteUnread(
    chunks.flatMap((chunk) => chunk.hits),
    lastReadById,
    selfId,
    { truncatedIds, horizonTs },
  );
}

// お気に入りのまとめ検索の結果がある会話の ID（結果で 0 件だった会話も含む）。
// 結果が来るまで（取得中・停止・失敗）の会話は含まれず、未読タグは自分宛ての件数で出す。
// 結果にあっても、お気に入りでなくなった会話は含めない。
// 結果が件数不明（isCountUnknown）の会話も含まれる。その会話を結果が無いのと同じに扱うのは、数える側（unreadTags）
export function favoritesWithResult(
  chunks: readonly Pick<FavoriteChunk, "ids">[],
  favoriteIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    chunks.flatMap((chunk) => chunk.ids).filter((id) => favoriteIds.has(id)),
  );
}

// 件数不明（0 件で下限）の会話の、個別に確かめた結果のキー。既読位置が進めば別のキーになる
export const unknownCheckKey = (id: string, lastRead: string) =>
  `${id}:${lastRead}`;

export type UnknownCheck = { id: string; lastRead: string; key: string };

// 個別に確かめる会話を選ぶ。件数不明（0 件で下限）の会話のうち、先頭から limit 件
export function pickUnknownChecks(
  summary: readonly FavoriteUnread[],
  lastReadById: ReadonlyMap<string, string>,
  limit = UNKNOWN_CHECKS,
): UnknownCheck[] {
  const picks: UnknownCheck[] = [];
  for (const f of summary) {
    if (!isCountUnknown(f)) continue;
    const lastRead = lastReadById.get(f.channelId);
    if (lastRead === undefined) continue;
    picks.push({
      id: f.channelId,
      lastRead,
      key: unknownCheckKey(f.channelId, lastRead),
    });
    if (picks.length >= limit) break;
  }
  return picks;
}

// 個別に確かめる会話を、検索に出す直前に1つ選ぶ（選べる会話が無ければ undefined）。次の会話は選ばない：
// - 確かめ終えて保存してある結果（done）がある会話。検索しないので、上限には数えない
// - この表示で、すでに確かめに出した会話（requested）。既読位置が進んで結果のキーが変わった会話も、この表示では出し直さない
// - いま確かめている最中の会話（checking）。ほかの取得が検索していて、保存はまだ。表示をまたいで見る
// requested が limit に達していたら、もう選ばない（1回の表示で3会話まで）。
// 選んだら、呼び出し側が、検索の前（待たずに続けて）requested と checking へ加える
export function nextCheck(params: {
  picks: readonly UnknownCheck[];
  requested: ReadonlySet<string>;
  checking: { has: (id: string) => boolean };
  done: Readonly<Record<string, unknown>>;
  limit?: number;
}): UnknownCheck | undefined {
  const { picks, requested, checking, done, limit = UNKNOWN_CHECKS } = params;
  if (requested.size >= limit) return undefined;
  return picks.find(
    (pick) =>
      !Object.hasOwn(done, pick.key) &&
      !requested.has(pick.id) &&
      !checking.has(pick.id),
  );
}

// 1会話を個別に検索した結果（既読位置の日から古い順に取ったもの）から、未読数を出す。未読が無ければ null。
// 古い順に取ったので、上限で切れたら新しい側が取れておらず、件数は下限になる
export function summarizeCheck(params: {
  hits: readonly FavoriteHit[];
  id: string;
  lastRead: string;
  capped: boolean;
  selfId: string;
}): FavoriteUnread | null {
  const { hits, id, lastRead, capped, selfId } = params;
  const [entry] = summarizeFavoriteUnread(
    hits,
    new Map([[id, lastRead]]),
    selfId,
    { truncatedIds: capped ? new Set([id]) : new Set(), horizonTs: "0" },
  );
  return entry ?? null;
}

// 個別に確かめた結果をお気に入りの未読に反映する。
// 件数不明（0 件で下限）の会話は、まだ確かめていなければそのまま残し、確かめて未読が無ければ外し、あれば確かめた結果に替える
export function applyChecks(
  summary: readonly FavoriteUnread[],
  checks: Readonly<Record<string, FavoriteUnread | null>>,
  lastReadById: ReadonlyMap<string, string>,
): FavoriteUnread[] {
  return summary.flatMap((f) => {
    if (!isCountUnknown(f)) return [f];
    const lastRead = lastReadById.get(f.channelId);
    const checked =
      lastRead === undefined
        ? undefined
        : checks[unknownCheckKey(f.channelId, lastRead)];
    if (checked === undefined) return [f];
    return checked ? [checked] : [];
  });
}

// ---- 空欄の一覧に出す自分宛ての行 ---------------------------------------------------

// 空欄の一覧に出す状態。開いたときの判定で、未読・スレッド・判定できないものを出す。
// 印の付いたもの（開いた・対応済み）と、既読のものは出さない
const LISTED_STATES: ReadonlySet<ReadState> = new Set<ReadState>([
  "unread",
  "thread",
  "unknown",
]);

export type Judged = { hit: Hit; state: ReadState };

// 出した行の記録（key → 出したときの Hit）。この記録にある行は、開いている間、裏の更新で消さない。
// 選択中の行が裏で消えると、Raycast が別の行を選び、↵ や ⌘↵ が別のメッセージに効くため。
// key だけでなく Hit ごと持つのは、取り直した検索結果から外れた行（上限・期間の端・削除）も残すため
export type Shown = ReadonlyMap<string, Hit>;
export const NOTHING_SHOWN: Shown = new Map();

const newestFirst = (a: Hit, b: Hit) =>
  compareTs(b.ts, a.ts) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// 空欄の一覧に出す行を、新しい順に返す。
// - 未読・スレッド・判定できないものを出す
// - 出した行の記録にあるもの（shown）は、開いている間に既読になっても、印だけ変えて残す
// - 印が付いたもの（開いた・対応済み）は、記録にあっても外す
// - 取り直した検索結果から外れた行も、記録にあれば残す
export function triageRows(
  hits: readonly Hit[],
  judge: (hit: Hit) => ReadState,
  shown: Shown,
): Judged[] {
  const byKey = new Map<string, Hit>();
  for (const hit of hits) byKey.set(hit.key, hit);
  for (const [key, hit] of shown) {
    if (!byKey.has(key)) byKey.set(key, hit);
  }
  const rows: Judged[] = [];
  for (const hit of [...byKey.values()].sort(newestFirst)) {
    const state = judge(hit);
    if (LISTED_STATES.has(state) || (state === "read" && shown.has(hit.key))) {
      rows.push({ hit, state });
    }
  }
  return rows;
}

// 出している行を、出した行の記録に足す。足すものが無ければ同じ記録を返す（無駄に作り直さない）。
// 記録を空にして足し直す（⌘R のあと）と、既読になった行が外れる
export function rememberShown(shown: Shown, rows: readonly Judged[]): Shown {
  let next: Map<string, Hit> | undefined;
  for (const { hit } of rows) {
    if (shown.has(hit.key)) continue;
    next ??= new Map(shown);
    next.set(hit.key, hit);
  }
  return next ?? shown;
}

// ---- 保存した値を読む ---------------------------------------------------------------
// Raycast の Cache は文字列で、壊れていたり形が違ったりしうる。形が合うものだけを使い、合わなければ捨てる
// （画面の描画で落ちて、開くたびに落ち続けるのを避けるため）

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown) =>
  value === undefined || typeof value === "string";
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const CHANNEL_KINDS = new Set(["channel", "private", "im", "mpim"]);

function isHit(value: unknown): value is Hit {
  if (!isRecord(value)) return false;
  return (
    isString(value.key) &&
    isString(value.channelId) &&
    isString(value.ts) &&
    isString(value.permalink) &&
    isString(value.text) &&
    isString(value.channelKind) &&
    CHANNEL_KINDS.has(value.channelKind) &&
    typeof value.mentionsSelf === "boolean" &&
    isOptionalString(value.threadTs) &&
    isOptionalString(value.userId) &&
    isOptionalString(value.username) &&
    isOptionalString(value.channelName)
  );
}

function isFavoriteHit(value: unknown): value is FavoriteHit {
  if (!isRecord(value)) return false;
  return (
    isString(value.channelId) &&
    isString(value.ts) &&
    isOptionalString(value.threadTs) &&
    isOptionalString(value.userId)
  );
}

function isFavoriteUnread(value: unknown): value is FavoriteUnread {
  if (!isRecord(value)) return false;
  return (
    isString(value.channelId) &&
    isTime(value.count) &&
    isOptionalString(value.latestTs) &&
    typeof value.truncated === "boolean"
  );
}

// 会話 ID → 既読位置。形の合う行だけ読む
export function parseLastReads(raw: unknown): Map<string, CachedLastRead> {
  const entries = new Map<string, CachedLastRead>();
  if (!isRecord(raw)) return entries;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const { lastRead, at } = entry;
    if (!isTime(at)) continue;
    if (lastRead === null || isString(lastRead)) {
      entries.set(id, { lastRead, at });
    }
  }
  return entries;
}

// メッセージの key → 印を付けた時刻
export function parseMarks(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, number] =>
      isTime(entry[1]),
    ),
  );
}

// 保存した開いた時刻を読む。会話 ID → ts（秒.マイクロ秒）の形が合うものだけ使う
const SLACK_TS = /^\d{10}\.\d{6}$/;
export function parseOpened(raw: unknown): Opened {
  if (!isRecord(raw)) return {};
  const opened: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (isString(value) && SLACK_TS.test(value)) opened[id] = value;
  }
  return opened;
}

// 自分宛ての検索結果。本文は Hit の時点で300字に切ってある。
// cappedBefore は、検索が件数の上限で切れたときの境目（cappedBeforeOf）。切れていなければ持たない
export type Mentions = { hits: Hit[]; cappedBefore?: string };

// 前回の整理の結果
export type TriageEntry = Mentions & { at: number };

// 保存した結果から、時刻を除いて自分宛ての結果だけを取り出す
export function mentionsOf(entry: TriageEntry): Mentions {
  return {
    hits: entry.hits,
    ...(entry.cappedBefore !== undefined && {
      cappedBefore: entry.cappedBefore,
    }),
  };
}

export function parseTriageEntry(raw: unknown): TriageEntry | undefined {
  if (!isRecord(raw) || !isTime(raw.at) || !Array.isArray(raw.hits)) {
    return undefined;
  }
  return {
    at: raw.at,
    hits: raw.hits.filter(isHit),
    // 形の合わない境目は使わない（次に取り直したときに付け直される）
    ...(isString(raw.cappedBefore) &&
      SLACK_TS.test(raw.cappedBefore) && { cappedBefore: raw.cappedBefore }),
  };
}

// お気に入りのまとめ検索の結果。key はお気に入りの組み合わせ
export type FavoriteEntry = {
  at: number;
  key: string;
  chunks: FavoriteChunk[];
};

function isFavoriteChunk(value: unknown): value is FavoriteChunk {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.ids) &&
    value.ids.every(isString) &&
    Array.isArray(value.hits) &&
    value.hits.every(isFavoriteHit) &&
    typeof value.capped === "boolean"
  );
}

export function parseFavoriteEntry(raw: unknown): FavoriteEntry | undefined {
  if (
    !isRecord(raw) ||
    !isTime(raw.at) ||
    !isString(raw.key) ||
    !Array.isArray(raw.chunks) ||
    !raw.chunks.every(isFavoriteChunk)
  ) {
    return undefined;
  }
  return { at: raw.at, key: raw.key, chunks: raw.chunks };
}

// 保存したお気に入りの結果のうち、いまのお気に入りの組み合わせ（key）で、期限内のものだけ返す
export function freshFavoriteChunks(
  entry: FavoriteEntry | undefined,
  key: string,
  maxAgeMs: number,
  now: number,
): FavoriteChunk[] | undefined {
  return entry && entry.key === key && now - entry.at < maxAgeMs
    ? entry.chunks
    : undefined;
}

// 件数不明だった会話を個別に確かめた結果。キーは unknownCheckKey、result の null は未読なし
export type CheckEntry = { at: number; result: FavoriteUnread | null };

export function parseChecks(raw: unknown): Record<string, CheckEntry> {
  if (!isRecord(raw)) return {};
  const entries: Record<string, CheckEntry> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || !isTime(entry.at)) continue;
    if (entry.result === null || isFavoriteUnread(entry.result)) {
      entries[key] = { at: entry.at, result: entry.result };
    }
  }
  return entries;
}

// 個別に確かめた結果のうち、持つ期間を過ぎていないものだけ残す
export function pruneChecks(
  entries: Readonly<Record<string, CheckEntry>>,
  now: number,
): Record<string, CheckEntry> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, e]) => now - e.at <= CHECK_KEEP_MS),
  );
}
