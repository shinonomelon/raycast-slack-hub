import { showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readPause, writePause } from "./gate-store.ts";
import type { Hit } from "./hits.ts";
import { scopeKey, type Identity, type Session } from "./identity.ts";
import { readStateOf } from "./read-state.ts";
import { runSlackCli } from "./slack-cli-runner.ts";
import { getLastReads, searchPage } from "./slack.ts";
import {
  createTriageFetchers,
  type Stop,
  type TriageFetchers,
} from "./triage-fetch.ts";
import {
  applyChecks,
  chunkFavorites,
  favoritesWithResult,
  judgeReadState,
  lastReadsForTags,
  mineCompleteFrom,
  NOTHING_SHOWN,
  pickUnknownChecks,
  rememberShown,
  sinceTs,
  summarizeFavorites,
  TRIAGE_DAYS,
  triageRows,
  wantedConversations,
  type FavoriteChunk,
  type FavoriteUnread,
  type Judged,
  type Opened,
  type Shown,
} from "./triage.ts";
import {
  conversationsOfRow,
  unreadTags,
  type UnreadTag,
} from "./unread-tags.ts";

// 取得の本体は triage-fetch.ts。ここでは、保存（read-state）・止める期限（gate-store）・slack-cli をつなぐ。
// 取得は、人（ワークスペースと自分の ID）ごとに、モジュールで1つだけ動かす
// （画面が重なって開かれても、ray develop で開いたときの処理が2回走っても、検索は重ならない）。
// 保存は、その人の名前空間（read-state.ts）。止める期限（gate-store）は、拡張で共通
const fetchersByScope = new Map<string, TriageFetchers>();

function fetchersOf(identity: Identity): TriageFetchers {
  const scope = scopeKey(identity);
  let fetchers = fetchersByScope.get(scope);
  if (!fetchers) {
    const store = readStateOf(identity);
    fetchers = createTriageFetchers({
      selfId: identity.userId,
      now: Date.now,
      readPause,
      writePause,
      loadTriage: store.loadTriage,
      saveTriage: store.saveTriage,
      loadFavoriteHits: store.loadFavoriteHits,
      saveFavoriteHits: store.saveFavoriteHits,
      loadLastReads: store.loadLastReads,
      forgottenAt: store.lastReadForgottenAt,
      saveLastReads: store.saveLastReads,
      loadUnknownChecks: store.loadUnknownChecks,
      saveUnknownCheck: store.saveUnknownCheck,
      searchPage: (query, options) =>
        searchPage(query, {
          ...options,
          run: runSlackCli,
          selfId: identity.userId,
        }),
      getLastReads: (ids) => getLastReads(ids, { run: runSlackCli }),
    });
    fetchersByScope.set(scope, fetchers);
  }
  return fetchers;
}

// ---- 画面に出すお知らせ --------------------------------------------------------------

// 止めた・失敗したことを、トーストで知らせる（what はお知らせの主語）。
// 本文は出さない（slack-cli のエラー文と、止める時刻だけ）
function notify(stop: Stop, what: string): void {
  const text =
    stop.kind === "failed"
      ? { title: `${what}を取得できませんでした`, message: stop.message }
      : {
          title:
            stop.pause.cause === "rate_limited"
              ? "Slack の回数制限に当たりました"
              : "Slack への問い合わせが時間切れでした",
          message: `${new Date(stop.pause.until).toLocaleTimeString("ja-JP")} まで${what}の取得を止めます（そのあと、⌘R で取り直せます）`,
        };
  try {
    void showToast({ style: Toast.Style.Failure, ...text }).catch(
      () => undefined,
    );
  } catch {
    // 知らせられなかっただけで、取得の結果は変わらない
  }
}

// ---- フック ---------------------------------------------------------------------------

export type Triage = {
  // 空欄の一覧に出す自分宛ての行（新しい順）。開いたときの判定で未読・スレッド・判定できないものだけで、
  // 印（開いた・対応済み）の付いたものは出ない。開いている間に既読になった行は、印だけ変えて残る
  rows: readonly Judged[];
  // 行の id（会話の ID。DM は相手のユーザー ID）ごとの未読タグ
  tags: ReadonlyMap<string, UnreadTag>;
  // 未読のある行の id（会話の並びで、未読のあるものを上にするために使う）
  unreadIds: ReadonlySet<string>;
  // 開いたときに未読だった行の id（前回までに開いた会話は含めない）。参加中の絞り込みで人の行が裏で消えないよう、
  // 裏の更新では変えない
  openUnread: ReadonlySet<string>;
  // 対応済みの印のあるメッセージの key（検索結果の行にも印を出すため）
  marks: ReadonlySet<string>;
  isLoading: boolean;
  // ⌘R：自分宛ての検索・既読位置・お気に入りの未読を、キャッシュの新しさに関わらず取り直す
  // （止めている間は取り直さない）。そのあと、既読になって残っていた行が消える
  revalidate: () => void;
  // メッセージの行を開いた：印を付け、その会話の既読位置を忘れる（次に開いたとき取り直す）
  markOpened: (hit: Hit) => void;
  // メッセージの行から返信を送れた（成功のときだけ呼ぶ）：開いたときと同じ印を付け、既読位置を忘れる。
  // 保存にだけ付け、開いている一覧の行は消さない（REQ-023。消えるのは次に開いたとき）
  markReplied: (hit: Hit) => void;
  // 会話の行（人の行は、その人との DM）を開いた：その行の未読タグをすぐ消す。次に既読位置を Slack から
  // 取り直すまでは、開いた時刻までを既読として数える。取り直したら、Slack の値で数え直す（Open Channel と同じ動き）
  markConversationOpened: (row: { id: string; isPerson: boolean }) => void;
  // ⌘⇧D：印を付け外しする。印が付いた行は、空欄の一覧からすぐ消える
  toggleHandled: (hit: Hit) => void;
};

// 自分宛てのメッセージの整理と、会話の未読タグ。
// 開いたときに、前回の結果をすぐ出し、新しくなければ裏で取り直す。取り直しは、開いたときと ⌘R のときだけ。
// 前回の結果は、その人（session.display）の保存から出す。Slack から取って保存するのは、今回の whoami が成功したとき
// （session.canFetch）の、その人（session.fetchAs）の名前空間にだけ。
// 前回と同じプロファイルのトークンが別のワークスペースのものに替わっていても、混ざらないようにするため
export function useTriage(params: {
  // お気に入りの会話（人を除く）の ID。お気に入りの順
  favoriteIds: readonly string[];
  session: Session;
}): Triage {
  const { session } = params;
  // 一覧に出す人（前回の結果の人でもよい）。保存の読み書きと、未読タグに使う自分の ID は、この人のもの
  const { display } = session;
  const selfId = display.userId;
  const store = readStateOf(display);
  // Slack から取る人の取得器。今回の whoami が成功するまで（session.canFetch が false の間）は無く、
  // 下の取得の effect は、どれも何もしない
  const fetchers = session.canFetch ? fetchersOf(session.fetchAs) : undefined;
  // 検索するお気に入りは、10会話ずつ5つ（50会話）まで。それより後は、お気に入りの件数でなく自分宛ての件数で出る
  const favoriteList = useMemo(
    () => chunkFavorites(params.favoriteIds).flat(),
    [params.favoriteIds],
  );
  const favoriteKey = favoriteList.join(",");
  const favoriteSet = useMemo(() => new Set(favoriteList), [favoriteList]);

  // 開いたときの保存（前回の結果・既読位置・開いた会話）。すぐ出す。開いたときの未読の組もここで決める
  const [initial] = useState(() => {
    const entry = store.loadTriage();
    const hits = entry?.hits ?? [];
    const cappedBefore = entry?.cappedBefore;
    const lastReads = store.loadLastReads();
    const opened = store.loadOpened();
    const openUnread = new Set(
      unreadTags({
        mine: hits,
        lastReads: lastReadsForTags(lastReads, opened),
        favorites: [],
        favoriteResultIds: new Set(),
        mineFrom: mineCompleteFrom(
          sinceTs(new Date(), TRIAGE_DAYS),
          cappedBefore,
        ),
        selfId,
      }).keys(),
    );
    return { hits, cappedBefore, lastReads, opened, openUnread };
  });
  const [hits, setHits] = useState<Hit[]>(initial.hits);
  // 自分宛ての検索が件数の上限で切れたときの境目（切れていなければ undefined）。hits と一緒に変える
  const [cappedBefore, setCappedBefore] = useState<string | undefined>(
    initial.cappedBefore,
  );
  const [lastReads, setLastReads] = useState(initial.lastReads);
  // 会話の行を開いた時刻（会話 ID → ts）。開いた会話の未読タグを消すために使う
  const [opened, setOpened] = useState<Opened>(initial.opened);
  const [marks, setMarks] = useState(() => store.loadMarks());
  const [chunks, setChunks] = useState<FavoriteChunk[]>([]);
  const [checks, setChecks] = useState(() => store.loadUnknownChecks());
  // 出した行の記録。開いている間、既読になった行を消さないために使う
  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  // ⌘R を押した回数。取り直しのきっかけ
  const [nonce, setNonce] = useState(0);
  // ⌘R のあと、既読位置の取り直しが終わった回数。出した行の記録を空にし直すきっかけ
  const [resets, setResets] = useState(0);
  const [busy, setBusy] = useState(0);
  // 取り直しの番号ごとに、1回だけキャッシュに関わらず取り直すための記録（同じ番号で何度も強制しない）
  const forcedNonce = useRef({ lastReads: 0, favorites: 0 });
  const resetPending = useRef(false);
  const handledResets = useRef(0);
  // この表示で、個別の確かめに出した会話の ID。選び直しで確かめる組が変わっても、1回の表示で3会話までに守る
  const requestedChecks = useRef(new Set<string>());

  // 取得中の数を数える。終わったら（画面が閉じたあとも含め）必ず戻す
  const track = useCallback(<T>(task: Promise<T>): Promise<T> => {
    setBusy((n) => n + 1);
    return task.finally(() => setBusy((n) => n - 1));
  }, []);

  // 自分宛て：開いたときと ⌘R のときだけ取る（自分の情報が取れてから）
  useEffect(() => {
    if (!fetchers) return;
    let alive = true;
    void track(fetchers.fetchMentions(nonce > 0)).then((result) => {
      // 閉じた・次の取り直しに替わったあとの結果は使わない（取得そのものは最後まで行い、保存される）
      if (!alive) return;
      if (result.kind === "ok") {
        setHits(result.value.hits);
        setCappedBefore(result.value.cappedBefore);
      } else notify(result, "自分宛て");
    });
    return () => {
      alive = false;
    };
  }, [nonce, track, fetchers]);

  // 既読位置：お気に入り、自分宛ての会話（新しい順）の順に、1回20会話まで取り直す
  const wantedKey = useMemo(
    () => wantedConversations(favoriteList, hits).join(","),
    [favoriteList, hits],
  );
  useEffect(() => {
    if (!fetchers) return;
    let alive = true;
    const force = nonce !== forcedNonce.current.lastReads;
    forcedNonce.current.lastReads = nonce;
    const wanted = wantedKey ? wantedKey.split(",") : [];
    void track(fetchers.refreshLastReads(wanted, force)).then((round) => {
      if (!alive) return;
      // 取れなかった会話の古い値は、このまま持つ（既読位置は進むだけで、古い値は未読と見誤る側にしか外れない）
      setLastReads((current) => new Map([...current, ...round.lastReads]));
      if (round.stop) notify(round.stop, "既読位置");
      // ⌘R のあと、最初に終わった取り直しで、出した行の記録を空にし直す
      if (resetPending.current) {
        resetPending.current = false;
        setResets((n) => n + 1);
      }
    });
    return () => {
      alive = false;
    };
  }, [wantedKey, nonce, track, fetchers]);

  // お気に入りの未読：お気に入りが変わったときと ⌘R のときも取る
  useEffect(() => {
    if (!fetchers) return;
    let alive = true;
    const force = nonce !== forcedNonce.current.favorites;
    forcedNonce.current.favorites = nonce;
    const ids = favoriteKey ? favoriteKey.split(",") : [];
    void track(fetchers.fetchFavorites(ids, force)).then((result) => {
      if (!alive) return;
      if (result.kind === "ok") setChunks(result.value);
      else notify(result, "お気に入りの未読");
    });
    return () => {
      alive = false;
    };
  }, [favoriteKey, nonce, track, fetchers]);

  // 未読タグを数える既読位置。会話の行を開いた分を反映する（開いた会話は、取り直すまで、開いた時刻までを既読として数える）。
  // 空欄の一覧の自分宛ての行の判定（judge）は、開いた会話を反映せず、Slack の既読位置をそのまま使う
  const tagLastReads = useMemo(
    () => lastReadsForTags(lastReads, opened),
    [lastReads, opened],
  );

  // お気に入りの会話ごとの未読。件数不明の会話は、先頭から3件まで個別に確かめて反映する
  const summary = useMemo(
    () =>
      summarizeFavorites({
        chunks,
        favoriteIds: favoriteList,
        lastReads: tagLastReads,
        selfId,
        horizonTs: sinceTs(new Date(), TRIAGE_DAYS),
      }),
    [chunks, favoriteList, tagLastReads, selfId],
  );
  const picks = useMemo(
    () => pickUnknownChecks(summary, tagLastReads),
    [summary, tagLastReads],
  );
  const checkKey = picks.map((p) => p.key).join(",");
  useEffect(() => {
    if (picks.length === 0 || !fetchers) return;
    let alive = true;
    void track(fetchers.fetchChecks(picks, requestedChecks.current)).then(
      (result) => {
        if (!alive) return;
        // 途中まで確かめた分も、保存してあるものを読み直して反映する
        setChecks(store.loadUnknownChecks());
        if (result.kind !== "ok") notify(result, "お気に入りの未読");
      },
    );
    return () => {
      alive = false;
    };
    // picks は checkKey から決まる（キーが同じなら、確かめる会話も同じ）。
    // どの会話を実際に検索するかは、1つずつ fetchChecks が決める（この表示の3会話まで）
  }, [checkKey, track, fetchers]);
  const favoriteRows = useMemo<FavoriteUnread[]>(
    () => applyChecks(summary, checks, tagLastReads),
    [summary, checks, tagLastReads],
  );

  // お気に入りのまとめ検索の結果がある会話。結果が来るまで（取得中・停止・失敗）の会話は、自分宛ての件数で出す
  const favoriteResultIds = useMemo(
    () => favoritesWithResult(chunks, favoriteSet),
    [chunks, favoriteSet],
  );

  // 会話の行の未読タグ。Slack の既読位置（と、開いた会話）だけで決まり、対応済みの印は効かせない。
  // 自分宛ての件数は、既読位置が、結果の揃っている期間の始まりより前なら下限（「3+」）になる
  const tags = useMemo(
    () =>
      unreadTags({
        mine: hits,
        lastReads: tagLastReads,
        favorites: favoriteRows,
        favoriteResultIds,
        mineFrom: mineCompleteFrom(
          sinceTs(new Date(), TRIAGE_DAYS),
          cappedBefore,
        ),
        selfId,
      }),
    [hits, tagLastReads, favoriteRows, favoriteResultIds, cappedBefore, selfId],
  );
  const unreadIds = useMemo(() => new Set(tags.keys()), [tags]);

  // 空欄の一覧の自分宛ての行。出した行は記録して、開いている間は消さない
  const judge = useCallback(
    (hit: Hit) =>
      judgeReadState(hit, lastReads.get(hit.channelId)?.lastRead, marks),
    [lastReads, marks],
  );
  const rows = useMemo(
    () => triageRows(hits, judge, shown),
    [hits, judge, shown],
  );
  useEffect(() => {
    const reset = handledResets.current !== resets;
    handledResets.current = resets;
    // ⌘R のあと（resets が増えたとき）は、記録を空にして、いまの判定で出し直す。既読になった行が消える
    setShown((current) =>
      reset
        ? rememberShown(NOTHING_SHOWN, triageRows(hits, judge, NOTHING_SHOWN))
        : rememberShown(current, rows),
    );
    // hits・judge は、resets が増えた回の描画の値を使う（既読位置の更新と同じ回に増やしている）
  }, [rows, resets]);

  const revalidate = useCallback(() => {
    resetPending.current = true;
    setNonce((n) => n + 1);
  }, []);

  // 開いた行は読むので印を付ける。会話の既読位置は進むので、次に取り直す（いまの判定は変えない）
  const markOpened = useCallback(
    (hit: Hit) => {
      store.addMark(hit.key);
      store.forgetLastRead(hit.channelId);
      setMarks(store.loadMarks());
    },
    [store],
  );
  // 返信を送れた。フォームはこのあと Slack を開いてウィンドウを閉じるので、その前に保存まで済ませる。
  // メモリの印は変えない：開いている一覧の行を消さず、次に開いたときに消える
  const markReplied = useCallback(
    (hit: Hit) => {
      store.addMark(hit.key);
      store.forgetLastRead(hit.channelId);
    },
    [store],
  );
  const toggleHandled = useCallback(
    (hit: Hit) => {
      store.toggleMark(hit.key);
      setMarks(store.loadMarks());
    },
    [store],
  );
  // 会話の行を開いた。人の行は、その人との DM の会話（自分宛ての中の DM から引く。タグを付けるときと同じ対応）。
  // メッセージの行を開いたときと同じく、その会話の既読位置を忘れる（Slack の既読位置が進むので、次に取り直す）。
  // さらに、開いた時刻を保存して、画面にも反映する（保存できなくても、この回の画面ではタグが消える）
  const markConversationOpened = useCallback(
    (row: { id: string; isPerson: boolean }) => {
      const ids = conversationsOfRow(row, hits);
      // 人の行で、その人との DM が自分宛ての中に無ければ、タグも付いていない
      if (ids.length === 0) return;
      for (const id of ids) store.forgetLastRead(id);
      setOpened(store.addOpened(ids));
    },
    [hits, store],
  );

  return {
    rows,
    tags,
    unreadIds,
    openUnread: initial.openUnread,
    marks,
    isLoading: busy > 0,
    revalidate,
    markOpened,
    markReplied,
    markConversationOpened,
    toggleHandled,
  };
}
