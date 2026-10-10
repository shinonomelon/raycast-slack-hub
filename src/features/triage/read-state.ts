import { Cache } from "@raycast/api";
import { cacheNamespace, type Identity } from "../../slack/identity.ts";
import {
  freshFavoriteChunks,
  handledKeys,
  markHandled,
  openConversations,
  parseChecks,
  parseFavoriteEntry,
  parseLastReads,
  parseMarks,
  parseOpened,
  parseTriageEntry,
  pruneChecks,
  pruneLastReads,
  pruneOpened,
  toggleHandled,
  toTriageCacheEntry,
  unmarkHandled,
  type CachedLastRead,
  type FavoriteChunk,
  type FavoriteUnread,
  type Opened,
  type TriageEntry,
} from "./triage.ts";

// Hub が手元に持つもの：会話ごとの既読位置、「開いた」「対応済み」の印、前回の整理の結果、
// お気に入りのまとめ検索の結果、件数不明の会話を個別に確かめた結果。
// 値の形・持つ期間・使ってよいかの判断は triage.ts の純粋な関数に任せ、ここは Cache との受け渡しだけにする
// （Cache を値として読むので、node のテストからは読み込めない）。
// 一覧（directory）・止める期限（search-gate）とは名前空間を分ける。同じフォルダの別の Cache と
// 索引を上書きし合い、一覧を失った前例があるため。
// さらに、ワークスペースと自分の ID ごとに分ける（identity.ts の cacheNamespace）。
// トークンやトークン設定を替えても、別の人の既読位置や印が混ざらない。
// アカウントを特定できない古い名前空間は読まない。
export function createReadState(namespace: string) {
  const cache = new Cache({ namespace });

  // 読めない・壊れている値は、無いものとして扱う（形の確認は triage.ts の parse 系の関数）
  function read(key: string): unknown {
    const raw = cache.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  // 保存できなくても、この回の画面は続ける（次に開いたときは、保存されていないものとして取り直す）
  function write(key: string, value: unknown): void {
    try {
      cache.set(key, JSON.stringify(value));
    } catch {
      // 保存できなかっただけ
    }
  }

  // ---- 既読位置 -----------------------------------------------------------------------

  function loadLastReads(): Map<string, CachedLastRead> {
    return parseLastReads(read("lastRead"));
  }

  // 持つ期間（1日）を過ぎたものは、保存のときに落とす
  function saveLastReads(
    entries: ReadonlyMap<string, CachedLastRead>,
    now = Date.now(),
  ): void {
    write("lastRead", Object.fromEntries(pruneLastReads(entries, now)));
  }

  // 既読位置を忘れた時刻（会話 ID → ミリ秒）。メモリにだけ持つ。既読位置の取得は同じプロセスの中で動くので、
  // 取っている間に忘れたかを知るにはこれで足りる（会話の数より増えない）
  const forgottenAt = new Map<string, number>();

  const lastReadForgottenAt = (channelId: string): number | undefined =>
    forgottenAt.get(channelId);

  // 開いた会話は既読位置が進むので、次に開いたときに取り直させる。保存から消し、忘れた時刻を記録する
  // （既読位置を取っている最中に忘れたとき、開く前の値で保存し直されないようにするため。triage.ts の keepFetchedLastReads）。
  // 保存に無い会話も、時刻は記録する
  function forgetLastRead(channelId: string, now = Date.now()): void {
    forgottenAt.set(channelId, now);
    const entries = loadLastReads();
    if (entries.delete(channelId)) saveLastReads(entries);
  }

  // ---- 印（開いた・対応済み） ----------------------------------------------------------

  const loadMarkTimes = () => parseMarks(read("marks"));

  // 印のあるメッセージの key。期限（14日）を過ぎたものは含めない
  function loadMarks(now = Date.now()): Set<string> {
    return handledKeys(loadMarkTimes(), now);
  }

  function addMark(key: string, now = Date.now()): void {
    write("marks", markHandled(loadMarkTimes(), key, now));
  }

  function removeMark(key: string, now = Date.now()): void {
    write("marks", unmarkHandled(loadMarkTimes(), key, now));
  }

  // 印が無ければ付け、あれば外す（⌘⇧D）
  function toggleMark(key: string, now = Date.now()): void {
    write("marks", toggleHandled(loadMarkTimes(), key, now));
  }

  // ---- 開いた会話 ----------------------------------------------------------------------

  // 会話の行を開いた時刻（会話 ID → ts）。開いた会話の未読タグをすぐ消すために使う。
  // 持つ期間を過ぎたものは含めない。保存するのは ID と ts だけ
  function loadOpened(now = Date.now()): Opened {
    return pruneOpened(parseOpened(read("opened")), now);
  }

  // 会話を開いた時刻を保存して、保存した全体を返す（画面がそのまま使う）。
  // 保存できなくても、返す値は変わらない（この回の画面は、開いた会話のタグを消したまま続く）
  function addOpened(ids: readonly string[], now = Date.now()): Opened {
    const next = openConversations(loadOpened(now), ids, now);
    write("opened", next);
    return next;
  }

  // ---- 前回の整理の結果（自分宛て） -----------------------------------------------------

  // 前回の結果。開いた直後に出して、裏で取り直す。
  // 本文は保存するコピーだけ300字に切る。画面に渡すHitは全文を持つ。
  // 検索が件数の上限で切れたときは、その境目（cappedBefore）も一緒に保存する
  function loadTriage(): TriageEntry | undefined {
    return parseTriageEntry(read("triage"));
  }

  function saveTriage(entry: TriageEntry): void {
    write("triage", toTriageCacheEntry(entry));
  }

  // ---- お気に入りのまとめ検索の結果 ------------------------------------------------------

  // お気に入りの組み合わせ（key）が変わっていたか、maxAgeMs を過ぎていたら使わない。
  // 保存するのは、数えるのに要る項目（会話・ts・スレッドの親・送信者）だけで、本文は持たない
  function loadFavoriteHits(
    key: string,
    maxAgeMs: number,
    now = Date.now(),
  ): FavoriteChunk[] | undefined {
    return freshFavoriteChunks(
      parseFavoriteEntry(read("favorites")),
      key,
      maxAgeMs,
      now,
    );
  }

  function saveFavoriteHits(
    key: string,
    chunks: FavoriteChunk[],
    now = Date.now(),
  ): void {
    write("favorites", { at: now, key, chunks });
  }

  // ---- 件数不明だった会話を個別に確かめた結果 ---------------------------------------------

  // キーは「会話ID:既読位置」で、null は未読なし。持つ期間（10分）を過ぎたものは読まない
  function loadUnknownChecks(
    now = Date.now(),
  ): Record<string, FavoriteUnread | null> {
    return Object.fromEntries(
      Object.entries(pruneChecks(parseChecks(read("unknownChecks")), now)).map(
        ([key, entry]) => [key, entry.result],
      ),
    );
  }

  function saveUnknownCheck(
    key: string,
    result: FavoriteUnread | null,
    now = Date.now(),
  ): void {
    write("unknownChecks", {
      ...pruneChecks(parseChecks(read("unknownChecks")), now),
      [key]: { at: now, result },
    });
  }

  return {
    loadLastReads,
    saveLastReads,
    lastReadForgottenAt,
    forgetLastRead,
    loadMarks,
    addMark,
    removeMark,
    toggleMark,
    loadOpened,
    addOpened,
    loadTriage,
    saveTriage,
    loadFavoriteHits,
    saveFavoriteHits,
    loadUnknownChecks,
    saveUnknownCheck,
  };
}

export type ReadStateStore = ReturnType<typeof createReadState>;

// その人（ワークスペースと自分の ID）の保存。モジュールで1つだけ持つ（既読位置を忘れた時刻はメモリに持つので、
// 画面が重なって開かれても、同じ人の保存は同じものを使う）
const stores = new Map<string, ReadStateStore>();

export function readStateOf(identity: Identity): ReadStateStore {
  const namespace = cacheNamespace("messages", identity);
  let store = stores.get(namespace);
  if (!store) {
    store = createReadState(namespace);
    stores.set(namespace, store);
  }
  return store;
}
