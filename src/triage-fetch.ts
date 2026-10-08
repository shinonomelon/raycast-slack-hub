// 自分宛て・既読位置・お気に入りの未読の取得。@raycast/api を読み込まないので、node のテストから動かせる
// （保存・止める期限・slack-cli の呼び出しは、ports で受け取る。画面側の use-triage.ts が本物をつなぐ）。
//
// 検索と既読位置の取得は、search-gate を通る：止めている間は取らず、時間切れ・回数制限のあとは次を止める。
// 回数制限は Slack の API の種類ごとに数えられるので、止める期限も種類（search・last-read）ごとに別々に持つ
import { compareTs, type Hit } from "./hits.ts";
import {
  decideSearch,
  isPaused,
  type GateKind,
  type Pause,
} from "./search-gate.ts";
import { createSerial, createSingleFlight } from "./single-flight.ts";
import type { LastReadsOutcome, SearchPageOutcome } from "./slack.ts";
import {
  cappedBeforeOf,
  chunkFavorites,
  decideLastReadStore,
  favoriteSearchQuery,
  keepFetchedLastReads,
  LAST_READ_OPTIONS,
  mentionQueries,
  mentionsOf,
  mergeHits,
  nextCheck,
  planRefresh,
  searchAfterDate,
  sinceTs,
  summarizeCheck,
  toFavoriteHit,
  TRIAGE_DAYS,
  TRIAGE_MAX_AGE_MS,
  unknownCheckQuery,
  type CachedLastRead,
  type FavoriteChunk,
  type FavoriteUnread,
  type Mentions,
  type TriageEntry,
  type UnknownCheck,
} from "./triage.ts";

// 取らなかった・取れなかった理由。止めている間は取らない（search-gate）。それ以外の失敗はエラー文を出す
export type Stop =
  { kind: "paused"; pause: Pause } | { kind: "failed"; message: string };

export type Fetched<T> = { kind: "ok"; value: T } | Stop;

export type LastReadRound = {
  lastReads: Map<string, CachedLastRead>;
  stop?: Stop;
};

// 取得が使うもの。本物は、保存が read-state.ts、止める期限が gate-store.ts、slack-cli の呼び出しが slack.ts
export type Ports = {
  // 自分のユーザー ID。自分宛ての検索と、未読の数え方（自分の投稿は数えない）に使う。
  // whoami で取った値を、取得を始める前に渡す
  selfId: string;
  now: () => number;
  readPause: (kind: GateKind, now: number) => Pause | undefined;
  // 保存した期限を返す（すでにある期限より前にはしない）
  writePause: (kind: GateKind, pause: Pause) => Pause;
  loadTriage: () => TriageEntry | undefined;
  saveTriage: (entry: TriageEntry) => void;
  loadFavoriteHits: (
    key: string,
    maxAgeMs: number,
    now: number,
  ) => FavoriteChunk[] | undefined;
  saveFavoriteHits: (key: string, chunks: FavoriteChunk[], now: number) => void;
  loadLastReads: () => Map<string, CachedLastRead>;
  // 会話の既読位置を忘れた時刻（行を開いたとき）。忘れていなければ undefined
  forgottenAt: (channelId: string) => number | undefined;
  saveLastReads: (
    entries: ReadonlyMap<string, CachedLastRead>,
    now: number,
  ) => void;
  loadUnknownChecks: (now: number) => Record<string, FavoriteUnread | null>;
  saveUnknownCheck: (
    key: string,
    result: FavoriteUnread | null,
    now: number,
  ) => void;
  searchPage: (
    query: string,
    options?: { sortDir?: "asc" | "desc" },
  ) => Promise<SearchPageOutcome>;
  getLastReads: (ids: readonly string[]) => Promise<LastReadsOutcome>;
};

export function createTriageFetchers(ports: Ports) {
  // 開いたときの処理は ray develop で2回走り、画面が重なって開かれることもある。
  // 同じ取得は1つだけ動かし、あとから来た呼び出しは、実行中のものの結果を受け取る（検索の回数が倍にならない）。
  // 画面を閉じても止めない（検索は15秒、既読位置は30秒で終わり、結果は保存されて、次に開いたときに使える）
  const flights = createSingleFlight();
  // 既読位置の取得は、1回ずつ順に行う。実行の直前に、そのときの保存から取る会話を選び直すので、前の回と重ならない
  const lastReadRounds = createSerial();
  // 個別の確かめで、いま検索している会話の ID と、その確かめが終わる（結果の保存まで済む）と解ける Promise。
  // 結果の保存はまだなので、別の取得（選んだ組が違う・前の表示から続いているもの）が同じ会話を重ねて検索しないよう、
  // 検索の間だけ持つ。重ねて検索しなかった取得は、この Promise で、結果が保存されるのを待つ
  const checking = new Map<string, Promise<void>>();

  // 検索が失敗したときの扱い。時間切れ・回数制限は、次の検索を止める期限を保存する（閉じて開き直しても止まったまま）。
  // 既読位置の取得（last-read）の期限とは別
  function stopOfSearch(
    outcome: Exclude<SearchPageOutcome, { kind: "ok" }>,
  ): Stop {
    if (outcome.kind === "aborted") {
      return { kind: "failed", message: "検索を中断しました" };
    }
    const { failure } = outcome;
    return failure.pause
      ? { kind: "paused", pause: ports.writePause("search", failure.pause) }
      : { kind: "failed", message: failure.message };
  }

  // 検索してよいか。止めている間（search の期限の内側）は、検索せずに、止めている期限を返す
  function pausedSearch(query: string): Pause | undefined {
    const now = ports.now();
    const gate = decideSearch(query, ports.readPause("search", now), now);
    return !gate.search && gate.reason === "paused" ? gate.pause : undefined;
  }

  // 自分宛て（過去7日）。前回の結果が新しければ、それを返す（⌘R のときは使わない）。
  // 2つの検索（メンション・to:）は並列に行い、どちらかが失敗したら、前回の結果を残して失敗にする。
  // 検索が件数の上限で切れたときは、揃っている範囲の境目（cappedBefore）も返して保存する（古い側の件数は下限になる）
  function fetchMentions(force: boolean): Promise<Fetched<Mentions>> {
    return flights("mentions", async (): Promise<Fetched<Mentions>> => {
      const now = ports.now();
      const cached = ports.loadTriage();
      if (!force && cached && now - cached.at < TRIAGE_MAX_AGE_MS) {
        return { kind: "ok", value: mentionsOf(cached) };
      }
      const queries = mentionQueries(
        ports.selfId,
        searchAfterDate(new Date(now), TRIAGE_DAYS),
      );
      // 2つの検索は同じ期限を見る
      const pause = pausedSearch(queries[0]);
      if (pause) return { kind: "paused", pause };

      const outcomes = await Promise.all(
        queries.map((query) => ports.searchPage(query)),
      );
      const searches: { hits: Hit[]; capped: boolean }[] = [];
      const stops: Stop[] = [];
      for (const outcome of outcomes) {
        if (outcome.kind === "ok") {
          searches.push({ hits: outcome.hits, capped: outcome.capped });
        } else stops.push(stopOfSearch(outcome));
      }
      if (stops.length > 0) {
        return stops.find((stop) => stop.kind === "paused") ?? stops[0];
      }
      const since = sinceTs(new Date(now), TRIAGE_DAYS);
      const hits = mergeHits(searches.map((s) => s.hits)).filter(
        (h) => compareTs(h.ts, since) >= 0,
      );
      const cappedBefore = cappedBeforeOf(searches);
      const mentions: Mentions = {
        hits,
        ...(cappedBefore !== undefined && { cappedBefore }),
      };
      ports.saveTriage({ at: ports.now(), ...mentions });
      return { kind: "ok", value: mentions };
    });
  }

  // お気に入りの未読。お気に入りを10会話ずつまとめて検索する（5つまで）。前回の結果が新しければ、それを返す。
  // 途中で止めた・失敗したときは、そこまでの結果を保存せず、前の結果を残す
  function fetchFavorites(
    ids: readonly string[],
    force: boolean,
  ): Promise<Fetched<FavoriteChunk[]>> {
    const key = ids.join(",");
    return flights(
      `favorites:${key}`,
      async (): Promise<Fetched<FavoriteChunk[]>> => {
        if (ids.length === 0) return { kind: "ok", value: [] };
        const now = ports.now();
        if (!force) {
          const cached = ports.loadFavoriteHits(key, TRIAGE_MAX_AGE_MS, now);
          if (cached) return { kind: "ok", value: cached };
        }
        const after = searchAfterDate(new Date(now), TRIAGE_DAYS);
        const chunks: FavoriteChunk[] = [];
        for (const part of chunkFavorites(ids)) {
          const query = favoriteSearchQuery(part, after);
          // 1つ検索するごとに、止めていないかを見る。止まったら、残りは検索しない
          const pause = pausedSearch(query);
          if (pause) return { kind: "paused", pause };
          const outcome = await ports.searchPage(query);
          if (outcome.kind !== "ok") return stopOfSearch(outcome);
          // 数えるのに要る項目だけを持つ（本文は保存しない）
          chunks.push({
            ids: part,
            hits: outcome.hits.map(toFavoriteHit),
            capped: outcome.capped,
          });
        }
        ports.saveFavoriteHits(key, chunks, ports.now());
        return { kind: "ok", value: chunks };
      },
    );
  }

  // 件数不明の会話を、既読位置の日から古い順に検索して確かめる（個別の確かめ）。
  // 確かめ終えたものは、そのつど保存する。止まった・失敗したときは、そこで終える（残りは件数不明のまま）。
  // 1つ確かめるごとに、検索に出す会話を選び直す（nextCheck）：
  // - requested はこの表示で確かめに出した会話の ID（表示ごとに空から持つ）。3会話に達したら、選び直しで組が変わっても出さない
  // - 別の取得が確かめている最中の会話は、重ねて検索しない。その確かめが終わる（結果が保存される）のを待ってから終える。
  //   画面は、取得が終わった時点で保存を読み直す。選び直しで古くなった取得の終わりでは反映されないので、
  //   いまの取得が、その結果の保存まで待つ
  // 止めている間に出せなかった会話は、出していないので requested に入れない。検索に出して失敗した会話は入れる（回数制限を守る）
  function fetchChecks(
    picks: readonly UnknownCheck[],
    requested: Set<string>,
  ): Promise<Fetched<null>> {
    return flights(
      `checks:${picks.map((p) => p.key).join(",")}`,
      async (): Promise<Fetched<null>> => {
        for (;;) {
          const pick = nextCheck({
            picks,
            requested,
            checking,
            done: ports.loadUnknownChecks(ports.now()),
          });
          if (!pick) {
            // 選べる会話が無い。この組の会話を別の取得が確かめている最中なら、その確かめが終わるのを待って、選び直す
            const others = picks.flatMap((p) => checking.get(p.id) ?? []);
            if (others.length === 0) return { kind: "ok", value: null };
            await Promise.all(others);
            continue;
          }
          const query = unknownCheckQuery(pick.id, pick.lastRead);
          const pause = pausedSearch(query);
          if (pause) return { kind: "paused", pause };
          // 選んだ直後（待たずに）出した印を付ける。ほかの取得が、同じ会話を選ばないようにする
          requested.add(pick.id);
          let finish!: () => void;
          checking.set(
            pick.id,
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
          );
          try {
            // 古い順に取る。上限で切れたら新しい側が取れておらず、件数は下限になる
            const outcome = await ports.searchPage(query, { sortDir: "asc" });
            if (outcome.kind !== "ok") return stopOfSearch(outcome);
            ports.saveUnknownCheck(
              pick.key,
              summarizeCheck({
                hits: outcome.hits,
                id: pick.id,
                lastRead: pick.lastRead,
                capped: outcome.capped,
                selfId: ports.selfId,
              }),
              ports.now(),
            );
          } finally {
            // 外してから待っている取得を進める（進んだ先で、この会話をまた選ばないように）
            checking.delete(pick.id);
            finish();
          }
        }
      },
    );
  }

  // 既読位置の取り直し。取り直す会話は、実行の直前の保存から選ぶ（新鮮なものは飛ばす。⌘R のときは選び直す）。
  // 取った結果のうち、保存するものと止める期限は triage.ts が決める：
  // - 参加していない・見えない会話は null で保存する（60分持つ）。回数制限・失敗は保存しない
  // - 回数制限が出たら、既読位置の取得だけを止める（last-read の期限）。検索は止めない
  // - 呼び出し全体の時間切れ（30秒）・回数制限は、既読位置の取得を止める
  function refreshLastReads(
    wanted: readonly string[],
    force: boolean,
  ): Promise<LastReadRound> {
    return lastReadRounds(async (): Promise<LastReadRound> => {
      const now = ports.now();
      const cached = ports.loadLastReads();
      const pick = planRefresh(wanted, cached, now, {
        ...LAST_READ_OPTIONS,
        force,
      });
      if (pick.length === 0) return { lastReads: cached };
      const pause = ports.readPause("last-read", now);
      if (isPaused(pause, now)) {
        return { lastReads: cached, stop: { kind: "paused", pause } };
      }

      // 問い合わせを始めた時刻。これ以降に既読位置を忘れた会話（行を開いた）は、結果を保存しない
      const requestedAt = ports.now();
      const outcome = await ports.getLastReads(pick);
      if (outcome.kind === "failed") {
        const { failure } = outcome;
        return {
          lastReads: cached,
          stop: failure.pause
            ? {
                kind: "paused",
                pause: ports.writePause("last-read", failure.pause),
              }
            : { kind: "failed", message: failure.message },
        };
      }
      const { save, pause: next } = decideLastReadStore(
        outcome.rows,
        ports.now(),
      );
      // 取っている間に、会話の行が開かれて、既読位置が忘れられているかもしれない：
      // - 取っていた会話そのものを忘れたものは、開く前の値なので保存しない（keepFetchedLastReads）
      // - 取っていない会話を忘れたものを戻さないよう、保存の直前に読み直して足す
      const keep = keepFetchedLastReads(save, ports.forgottenAt, requestedAt);
      const latest = ports.loadLastReads();
      for (const [id, entry] of keep) latest.set(id, entry);
      ports.saveLastReads(latest, ports.now());
      return {
        lastReads: latest,
        stop: next
          ? { kind: "paused", pause: ports.writePause(next.gate, next.pause) }
          : undefined,
      };
    });
  }

  return { fetchMentions, fetchFavorites, fetchChecks, refreshLastReads };
}

export type TriageFetchers = ReturnType<typeof createTriageFetchers>;
