import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import type { GateKind, Pause } from "../search/search-gate.ts";
import type { LastReadsOutcome, SearchPageOutcome } from "../../slack/slack.ts";
import { createTriageFetchers, type Ports } from "./triage-fetch.ts";
import {
  favoriteSearchQuery,
  freshFavoriteChunks,
  mentionQueries,
  NOTHING_COMPLETE_TS,
  searchAfterDate,
  toFavoriteHit,
  unknownCheckKey,
  unknownCheckQuery,
  type CachedLastRead,
  type FavoriteEntry,
  type FavoriteUnread,
  type TriageEntry,
} from "./triage.ts";
import type { LastReadRow } from "../../shared/types.ts";
import { conversationsOfRow } from "./unread-tags.ts";

// このテストは Slack も Slack API も呼ばない。保存・止める期限・Slack API の呼び出しは、メモリの偽物にする

const NOW = 1_759_560_000_000;
const NOW_SEC = NOW / 1000;

// 自分のユーザー ID（テスト用のダミー）。auth.test で取った値を、取得の側に渡す
const SELF_ID = "U0000000017";

// 現在から seconds 秒前の ts
const tsAgo = (seconds: number) => `${NOW_SEC - seconds}.000000`;

const hit = (channelId: string, ts: string, extra: Partial<Hit> = {}): Hit => ({
  key: `${channelId}:${ts}`,
  channelId,
  ts,
  permalink: "",
  text: "",
  channelKind: "channel",
  mentionsSelf: true,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// 非同期の処理が、いまある待ちを進めきるまで待つ
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const okPage = (hits: Hit[] = [], capped = false): SearchPageOutcome => ({
  kind: "ok",
  hits,
  capped,
});
const limitedPage = (seconds: number): SearchPageOutcome => ({
  kind: "failed",
  failure: {
    kind: "rate_limited",
    message: `A rate-limit has been reached, you may retry this request in ${seconds} seconds`,
    pause: { until: NOW + seconds * 1000, cause: "rate_limited" },
  },
});
const timeoutPage = (): SearchPageOutcome => ({
  kind: "failed",
  failure: {
    kind: "timeout",
    message: "検索が 15 秒以内に終わらず止めました",
    pause: { until: NOW + 30_000, cause: "timeout" },
  },
});
const errorPage = (message: string): SearchPageOutcome => ({
  kind: "failed",
  failure: { kind: "error", message },
});

const lastReadRow = (
  channelId: string,
  lastRead: string | null,
  reason: LastReadRow["reason"],
  retryAfter?: number,
): LastReadRow => ({
  channelId,
  lastRead,
  reason,
  ...(retryAfter !== undefined && { retryAfter }),
});

type SearchCall = { query: string; sortDir?: "asc" | "desc" };

// 偽の保存・期限・Slack API と、取得の組み立て。selfId は、auth.test で取った自分のユーザー ID
function setup(selfId: string = SELF_ID) {
  const state = {
    now: NOW,
    pauses: new Map<GateKind, Pause>(),
    pauseWrites: [] as { gate: GateKind; pause: Pause }[],
    triage: undefined as TriageEntry | undefined,
    triageSaves: 0,
    favorites: undefined as FavoriteEntry | undefined,
    favoriteSaves: 0,
    lastReads: new Map<string, CachedLastRead>(),
    // 会話の既読位置を忘れた時刻（行を開いたとき）
    forgotten: new Map<string, number>(),
    lastReadSaves: 0,
    checks: {} as Record<string, FavoriteUnread | null>,
    searches: [] as SearchCall[],
    lastReadCalls: [] as string[][],
    respondSearch: ((): Promise<SearchPageOutcome> =>
      Promise.resolve(okPage())) as (
      query: string,
      options?: { sortDir?: "asc" | "desc" },
    ) => Promise<SearchPageOutcome>,
    respondLastReads: ((ids: readonly string[]): Promise<LastReadsOutcome> =>
      Promise.resolve({
        kind: "ok",
        rows: ids.map((id) => lastReadRow(id, tsAgo(10), null)),
      })) as (ids: readonly string[]) => Promise<LastReadsOutcome>,
  };
  const ports: Ports = {
    selfId,
    now: () => state.now,
    readPause: (kind, now) => {
      const pause = state.pauses.get(kind);
      return pause && now < pause.until ? pause : undefined;
    },
    writePause: (gate, pause) => {
      state.pauseWrites.push({ gate, pause });
      const current = state.pauses.get(gate);
      const merged = current && current.until > pause.until ? current : pause;
      state.pauses.set(gate, merged);
      return merged;
    },
    loadTriage: () => state.triage,
    saveTriage: (entry) => {
      state.triage = entry;
      state.triageSaves += 1;
    },
    loadFavoriteHits: (key, maxAgeMs, now) =>
      freshFavoriteChunks(state.favorites, key, maxAgeMs, now),
    saveFavoriteHits: (key, chunks, now) => {
      state.favorites = { at: now, key, chunks };
      state.favoriteSaves += 1;
    },
    loadLastReads: () => new Map(state.lastReads),
    forgottenAt: (channelId) => state.forgotten.get(channelId),
    saveLastReads: (entries) => {
      state.lastReads = new Map(entries);
      state.lastReadSaves += 1;
    },
    loadUnknownChecks: () => ({ ...state.checks }),
    saveUnknownCheck: (key, result) => {
      state.checks[key] = result;
    },
    searchPage: (query, options) => {
      state.searches.push({ query, sortDir: options?.sortDir });
      return state.respondSearch(query, options);
    },
    getLastReads: (ids) => {
      state.lastReadCalls.push([...ids]);
      return state.respondLastReads(ids);
    },
  };
  return { state, fetchers: createTriageFetchers(ports) };
}

// 行を開いて、会話の既読位置を忘れる（read-state.ts の forgetLastRead と同じ：忘れた時刻を記録し、保存から消す）
function forget(state: ReturnType<typeof setup>["state"], ...ids: string[]) {
  for (const id of ids) {
    state.forgotten.set(id, state.now);
    state.lastReads.delete(id);
  }
}

const after = searchAfterDate(new Date(NOW), 7);
const [mentionQuery, toQuery] = mentionQueries(SELF_ID, after);

// ---- 自分宛て --------------------------------------------------------------------------

test("自分宛て：メンションと to: の2つを検索し、重複を除いて新しい順に並べ、7日より前を除いて保存する", async () => {
  const { state, fetchers } = setup();
  const newest = hit("C1", tsAgo(60));
  const shared = hit("D2", tsAgo(120), { channelKind: "im" });
  const old = hit("C3", `${NOW_SEC - 8 * 24 * 3600}.000000`);
  state.respondSearch = (query) =>
    Promise.resolve(
      okPage(query === mentionQuery ? [newest, shared] : [shared, old]),
    );

  const result = await fetchers.fetchMentions(false);
  assert.deepEqual(
    state.searches.map((s) => s.query),
    [mentionQuery, toQuery],
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(
    result.value.hits.map((h) => h.key),
    [newest.key, shared.key],
  );
  // 切れた検索が無いので、境目は持たない
  assert.deepEqual(result.value, { hits: result.value.hits });
  assert.deepEqual(state.triage, { at: NOW, hits: result.value.hits });
});

test("自分宛て：検索には、渡された自分のユーザー ID を使う（決め打ちの ID を使わない）", async () => {
  const other = "U0000000014";
  const { state, fetchers } = setup(other);

  await fetchers.fetchMentions(false);
  assert.deepEqual(
    state.searches.map((s) => s.query),
    mentionQueries(other, after),
  );
  for (const { query } of state.searches) {
    assert.ok(query.includes(other));
    assert.ok(!query.includes(SELF_ID));
  }
});

test("自分宛て：検索が上限で切れたら、切れた検索の取れた中で一番古い投稿の ts を境目として返して保存する。切れていない検索の古い投稿は境目にしない", async () => {
  const { state, fetchers } = setup();
  const cutAt = tsAgo(3_000);
  // メンションの検索は上限で切れ、取れた一番古いのは cutAt。to: の検索は切れておらず、もっと古い投稿まで取れている
  state.respondSearch = (query) =>
    Promise.resolve(
      query === mentionQuery
        ? okPage([hit("C1", tsAgo(60)), hit("C1", cutAt)], true)
        : okPage([hit("D2", tsAgo(100)), hit("D2", tsAgo(90_000))], false),
    );

  const result = await fetchers.fetchMentions(false);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.cappedBefore, cutAt);
  assert.equal(result.value.hits.length, 4);
  assert.equal(state.triage?.cappedBefore, cutAt);
});

test("自分宛て：2つの検索が両方切れたら、境目は新しいほう。切れた検索が1件も取れていないときは、すべてが境目より前になる", async () => {
  const both = setup();
  both.state.respondSearch = (query) =>
    Promise.resolve(
      query === mentionQuery
        ? okPage([hit("C1", tsAgo(60)), hit("C1", tsAgo(3_000))], true)
        : okPage([hit("D2", tsAgo(100)), hit("D2", tsAgo(500))], true),
    );
  const result = await both.fetchers.fetchMentions(false);
  assert.equal(result.kind === "ok" && result.value.cappedBefore, tsAgo(500));

  const empty = setup();
  empty.state.respondSearch = (query) =>
    Promise.resolve(
      query === mentionQuery ? okPage([], true) : okPage([hit("D2", tsAgo(5))]),
    );
  const nothing = await empty.fetchers.fetchMentions(false);
  assert.equal(
    nothing.kind === "ok" && nothing.value.cappedBefore,
    NOTHING_COMPLETE_TS,
  );
});

test("自分宛て：切れていなければ境目を持たない。前回の保存に境目があっても、取り直して切れていなければ消える。保存が新しければ、保存した境目をそのまま返す", async () => {
  const stored = hit("C1", tsAgo(300));
  const cutAt = tsAgo(3_000);

  // 取り直した：前回は切れていたが、今回は切れていない
  const refetched = setup();
  refetched.state.triage = {
    at: NOW - 10 * 60_000,
    hits: [stored],
    cappedBefore: cutAt,
  };
  const fresh = await refetched.fetchers.fetchMentions(false);
  assert.deepEqual(fresh.kind === "ok" && Object.keys(fresh.value), ["hits"]);
  assert.deepEqual(Object.keys(refetched.state.triage ?? {}), ["at", "hits"]);

  // 保存が新しい：検索せずに、保存した境目を返す
  const reused = setup();
  reused.state.triage = {
    at: NOW - 1_000,
    hits: [stored],
    cappedBefore: cutAt,
  };
  assert.deepEqual(await reused.fetchers.fetchMentions(false), {
    kind: "ok",
    value: { hits: [stored], cappedBefore: cutAt },
  });
  assert.equal(reused.state.searches.length, 0);
});

test("自分宛て：前回の結果が60秒より新しければ検索しない。60秒たてば検索する。⌘R（force）は新しくても検索する", async () => {
  const stored = hit("C1", tsAgo(300));
  const fresh = setup();
  fresh.state.triage = { at: NOW - 59_999, hits: [stored] };
  const reused = await fresh.fetchers.fetchMentions(false);
  assert.deepEqual(reused, { kind: "ok", value: { hits: [stored] } });
  assert.equal(fresh.state.searches.length, 0);

  const stale = setup();
  stale.state.triage = { at: NOW - 60_000, hits: [stored] };
  await stale.fetchers.fetchMentions(false);
  assert.equal(stale.state.searches.length, 2);

  const forced = setup();
  forced.state.triage = { at: NOW - 1_000, hits: [stored] };
  await forced.fetchers.fetchMentions(true);
  assert.equal(forced.state.searches.length, 2);
});

test("自分宛て：検索を止めている間は、検索しない。前回の結果にも触れない", async () => {
  const { state, fetchers } = setup();
  const stored = hit("C1", tsAgo(300));
  state.triage = { at: NOW - 10 * 60_000, hits: [stored] };
  const pause: Pause = { until: NOW + 20_000, cause: "rate_limited" };
  state.pauses.set("search", pause);

  // ⌘R（force）でも、止めている間は取り直さない
  for (const force of [false, true]) {
    assert.deepEqual(await fetchers.fetchMentions(force), {
      kind: "paused",
      pause,
    });
  }
  assert.equal(state.searches.length, 0);
  assert.equal(state.triageSaves, 0);

  // 期限が過ぎれば検索する
  state.now = NOW + 20_000;
  await fetchers.fetchMentions(true);
  assert.equal(state.searches.length, 2);
});

test("自分宛て：回数制限で失敗したら、検索を止める期限を保存し、前回の結果は変えない。既読位置の取得は止めない", async () => {
  const { state, fetchers } = setup();
  const stored = hit("C1", tsAgo(300));
  state.triage = { at: NOW - 10 * 60_000, hits: [stored] };
  state.respondSearch = (query) =>
    Promise.resolve(
      query === mentionQuery ? okPage([hit("C2", tsAgo(10))]) : limitedPage(45),
    );

  const result = await fetchers.fetchMentions(false);
  assert.deepEqual(result, {
    kind: "paused",
    pause: { until: NOW + 45_000, cause: "rate_limited" },
  });
  assert.deepEqual(state.pauseWrites, [
    { gate: "search", pause: { until: NOW + 45_000, cause: "rate_limited" } },
  ]);
  assert.equal(state.pauses.has("last-read"), false);
  // 片方だけ取れた結果は保存しない（前回の結果のまま）
  assert.equal(state.triageSaves, 0);
  assert.deepEqual(state.triage?.hits, [stored]);
});

test("自分宛て：時間切れは検索を30秒止める。Slack が断ったほかの失敗は、止めずにエラー文を返す", async () => {
  const timeout = setup();
  timeout.state.respondSearch = () => Promise.resolve(timeoutPage());
  assert.deepEqual(await timeout.fetchers.fetchMentions(false), {
    kind: "paused",
    pause: { until: NOW + 30_000, cause: "timeout" },
  });

  const failed = setup();
  failed.state.respondSearch = () =>
    Promise.resolve(errorPage("An API error occurred: invalid_cursor"));
  assert.deepEqual(await failed.fetchers.fetchMentions(false), {
    kind: "failed",
    message: "An API error occurred: invalid_cursor",
  });
  assert.equal(failed.state.pauses.size, 0);
  assert.equal(failed.state.triageSaves, 0);
});

test("自分宛て：開いたときの処理が2回走っても、検索は2つのまま（実行中の取得の結果を受け取る）", async () => {
  const { state, fetchers } = setup();
  const waiting = deferred<SearchPageOutcome>();
  state.respondSearch = () => waiting.promise;

  const first = fetchers.fetchMentions(false);
  const second = fetchers.fetchMentions(false);
  assert.equal(state.searches.length, 2);

  waiting.resolve(okPage([hit("C1", tsAgo(10))]));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(state.searches.length, 2);
  assert.equal(state.triageSaves, 1);

  // 終わったあとは、保存した結果が新しいので、検索しない
  await fetchers.fetchMentions(false);
  assert.equal(state.searches.length, 2);
});

// ---- お気に入りの未読 ------------------------------------------------------------------

const ids = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);

test("お気に入りは10会話ずつ順に検索する。保存するのは数えるのに要る項目だけ（本文は持たない）で、上限で切れたかは塊ごとに持つ", async () => {
  const { state, fetchers } = setup();
  const favorites = ids(23);
  state.respondSearch = (query) =>
    Promise.resolve(
      query.startsWith("in:<#C10>")
        ? okPage(
            [
              hit("C10", tsAgo(10), {
                text: "請求書を確認してください",
                permalink: "https://example.slack.com/archives/C10/p1",
                userId: "U9",
              }),
            ],
            true,
          )
        : okPage(),
    );

  const result = await fetchers.fetchFavorites(favorites, false);
  assert.deepEqual(
    state.searches.map((s) => s.query),
    [
      favoriteSearchQuery(favorites.slice(0, 10), after),
      favoriteSearchQuery(favorites.slice(10, 20), after),
      favoriteSearchQuery(favorites.slice(20), after),
    ],
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(
    result.value.map((chunk) => [chunk.ids.length, chunk.capped]),
    [
      [10, false],
      [10, true],
      [3, false],
    ],
  );
  assert.deepEqual(result.value[1].hits, [
    toFavoriteHit(hit("C10", tsAgo(10), { userId: "U9" })),
  ]);
  // 保存した文字列に、本文も permalink も入らない
  const saved = JSON.stringify(state.favorites);
  assert.equal(saved.includes("請求書"), false);
  assert.equal(saved.includes("example.slack.com"), false);
});

test("お気に入りは50会話までしか検索しない（まとめ検索は5つまで）", async () => {
  const { state, fetchers } = setup();
  await fetchers.fetchFavorites(ids(70), false);
  assert.equal(state.searches.length, 5);
});

test("お気に入りの結果は、お気に入りの組み合わせが同じで60秒以内なら使い、違うか⌘R（force）なら検索する。お気に入りが無ければ検索しない", async () => {
  const { state, fetchers } = setup();
  assert.deepEqual(await fetchers.fetchFavorites([], false), {
    kind: "ok",
    value: [],
  });
  assert.equal(state.searches.length, 0);

  await fetchers.fetchFavorites(["C1", "C2"], false);
  assert.equal(state.searches.length, 1);
  // 同じ組み合わせ・60秒以内：検索しない
  state.now = NOW + 59_000;
  await fetchers.fetchFavorites(["C1", "C2"], false);
  assert.equal(state.searches.length, 1);
  // 組み合わせが違う：検索する
  await fetchers.fetchFavorites(["C1", "C3"], false);
  assert.equal(state.searches.length, 2);
  // ⌘R：新しくても検索する
  await fetchers.fetchFavorites(["C1", "C3"], true);
  assert.equal(state.searches.length, 3);
  // 60秒を過ぎた：検索する
  state.now = NOW + 59_000 + 60_000;
  await fetchers.fetchFavorites(["C1", "C3"], false);
  assert.equal(state.searches.length, 4);
});

test("お気に入り：止めている間は検索しない。途中で回数制限になったら、残りは検索せず、そこまでの結果も保存しない", async () => {
  const paused = setup();
  const pause: Pause = { until: NOW + 20_000, cause: "timeout" };
  paused.state.pauses.set("search", pause);
  assert.deepEqual(await paused.fetchers.fetchFavorites(ids(23), false), {
    kind: "paused",
    pause,
  });
  assert.equal(paused.state.searches.length, 0);

  const midway = setup();
  let calls = 0;
  midway.state.respondSearch = () =>
    Promise.resolve(++calls === 2 ? limitedPage(45) : okPage());
  const result = await midway.fetchers.fetchFavorites(ids(23), false);
  // 3つ目は検索しない
  assert.equal(midway.state.searches.length, 2);
  assert.deepEqual(result, {
    kind: "paused",
    pause: { until: NOW + 45_000, cause: "rate_limited" },
  });
  assert.equal(midway.state.favoriteSaves, 0);
  assert.equal(midway.state.pauses.get("search")?.until, NOW + 45_000);
  assert.equal(midway.state.pauses.has("last-read"), false);
});

test("お気に入り：開いたときの処理が2回走っても、検索の回数は倍にならない", async () => {
  const { state, fetchers } = setup();
  const waiting = deferred<SearchPageOutcome>();
  state.respondSearch = () => waiting.promise;
  const first = fetchers.fetchFavorites(ids(5), false);
  const second = fetchers.fetchFavorites(ids(5), false);
  // 1つ目の塊の検索だけが、1回動いている
  assert.equal(state.searches.length, 1);
  waiting.resolve(okPage());
  await Promise.all([first, second]);
  assert.equal(state.searches.length, 1);
  assert.equal(state.favoriteSaves, 1);
});

// ---- 件数不明の会話の個別の確かめ -----------------------------------------------------------

test("個別の確かめ：確かめていない会話だけを、既読位置の日から古い順に検索し、結果をそのつど保存する", async () => {
  const { state, fetchers } = setup();
  const picks = [
    { id: "C1", lastRead: "1790856000.000100", key: "" },
    { id: "C2", lastRead: "1790856000.000200", key: "" },
  ].map((p) => ({ ...p, key: unknownCheckKey(p.id, p.lastRead) }));
  // C1 は確かめ済み
  state.checks[picks[0].key] = null;
  state.respondSearch = () =>
    Promise.resolve(okPage([hit("C2", "1790860000.000000")], true));

  const result = await fetchers.fetchChecks(picks, new Set());
  assert.deepEqual(result, { kind: "ok", value: null });
  assert.deepEqual(state.searches, [
    { query: unknownCheckQuery("C2", picks[1].lastRead), sortDir: "asc" },
  ]);
  // 古い順に取って上限で切れたので、件数は下限
  assert.deepEqual(state.checks[picks[1].key], {
    channelId: "C2",
    count: 1,
    latestTs: "1790860000.000000",
    truncated: true,
  });
});

test("個別の確かめ：自分の投稿は数えない。自分は、渡された自分のユーザー ID で決まる", async () => {
  const other = "U0000000014";
  const pick = { id: "C2", lastRead: "1790856000.000200", key: "" };
  pick.key = unknownCheckKey(pick.id, pick.lastRead);
  // 新しい順に、other の投稿・U9 の投稿・SELF_ID の投稿
  const posts = [
    hit("C2", "1790860300.000000", { userId: other }),
    hit("C2", "1790860200.000000", { userId: "U9" }),
    hit("C2", "1790860100.000000", { userId: SELF_ID }),
  ];

  // 自分が other のとき：other の投稿（いちばん新しい）を数えず、残りの2件の新しいほうが latestTs
  const asOther = setup(other);
  asOther.state.respondSearch = () => Promise.resolve(okPage(posts));
  await asOther.fetchers.fetchChecks([pick], new Set());
  assert.equal(asOther.state.checks[pick.key]?.count, 2);
  assert.equal(asOther.state.checks[pick.key]?.latestTs, "1790860200.000000");

  // 自分が SELF_ID のとき：SELF_ID の投稿を数えず、other の投稿が latestTs
  const asDefault = setup();
  asDefault.state.respondSearch = () => Promise.resolve(okPage(posts));
  await asDefault.fetchers.fetchChecks([pick], new Set());
  assert.equal(asDefault.state.checks[pick.key]?.count, 2);
  assert.equal(asDefault.state.checks[pick.key]?.latestTs, "1790860300.000000");
});

test("個別の確かめ：止まったら、残りは確かめない。そこまでの結果は保存されている", async () => {
  const { state, fetchers } = setup();
  const picks = ["C1", "C2", "C3"].map((id) => ({
    id,
    lastRead: "1790856000.000100",
    key: unknownCheckKey(id, "1790856000.000100"),
  }));
  let calls = 0;
  state.respondSearch = () =>
    Promise.resolve(++calls === 2 ? limitedPage(30) : okPage());
  const result = await fetchers.fetchChecks(picks, new Set());
  assert.equal(result.kind, "paused");
  assert.equal(state.searches.length, 2);
  assert.deepEqual(Object.keys(state.checks), [picks[0].key]);
  assert.equal(state.pauses.get("search")?.until, NOW + 30_000);
});

// 個別の確かめの組（会話 ID と既読位置から、結果のキーを付ける）
const checkPick = (id: string, lastRead = "1790856000.000100") => ({
  id,
  lastRead,
  key: unknownCheckKey(id, lastRead),
});
const checkQuery = (id: string, lastRead = "1790856000.000100") =>
  unknownCheckQuery(id, lastRead);

// 取得が終わった時点を記録する：終わったか、そのとき保存してあった確かめの結果のキー。
// 画面は取得が終わった時点で保存を読み直すので、その時点で結果が保存されていることを確かめる
function watchFinish(
  task: Promise<unknown>,
  state: ReturnType<typeof setup>["state"],
) {
  const seen = { finished: false, checks: [] as string[] };
  void task.then(() => {
    seen.finished = true;
    seen.checks = Object.keys(state.checks).sort();
  });
  return seen;
}

test("個別の確かめ：1回の表示で3会話まで。選び直しで確かめる組が変わっても、4つ目の会話は検索しない。新しく開いた表示では、また3会話まで", async () => {
  const { state, fetchers } = setup();
  const display = new Set<string>();

  await fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2"), checkPick("C3")],
    display,
  );
  assert.deepEqual([...display], ["C1", "C2", "C3"]);
  assert.equal(state.searches.length, 3);

  // C1 を開いて、選び直しで [C2, C3, C4] になった：C2・C3 は確かめ済み、C4 は4つ目なので出さない
  const reselected = await fetchers.fetchChecks(
    [checkPick("C2"), checkPick("C3"), checkPick("C4")],
    display,
  );
  assert.deepEqual(reselected, { kind: "ok", value: null });
  assert.equal(state.searches.length, 3);
  assert.equal(display.has("C4"), false);

  // 新しく開いた表示は、また3会話まで
  const nextDisplay = new Set<string>();
  await fetchers.fetchChecks([checkPick("C4")], nextDisplay);
  assert.deepEqual(
    state.searches.map((search) => search.query),
    ["C1", "C2", "C3", "C4"].map((id) => checkQuery(id)),
  );
});

test("個別の確かめ：保存してある結果がある会話は検索せず、上限にも数えない。同じ会話の既読位置が進んで結果のキーが変わっても、この表示では出し直さない", async () => {
  const { state, fetchers } = setup();
  const display = new Set<string>();
  // C1 は確かめ済み
  state.checks[checkPick("C1").key] = null;

  await fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2"), checkPick("C3")],
    display,
  );
  assert.deepEqual([...display], ["C2", "C3"]);
  assert.equal(state.searches.length, 2);

  // 上限に数えていないので、もう1会話（C4）は出せる。5つ目の C5 は出さない
  await fetchers.fetchChecks([checkPick("C4"), checkPick("C5")], display);
  assert.deepEqual([...display], ["C2", "C3", "C4"]);
  assert.equal(state.searches.length, 3);

  // C2 の既読位置が進んで結果のキーが変わっても、この表示で出した会話は出し直さない
  await fetchers.fetchChecks([checkPick("C2", "1790857000.000100")], display);
  assert.equal(state.searches.length, 3);
});

test("個別の確かめ：確かめている最中の会話は、選び直しで組が変わっても、重ねて検索しない（上限に達するまで、順に取り合う）", async () => {
  const { state, fetchers } = setup();
  const waits = new Map<
    string,
    ReturnType<typeof deferred<SearchPageOutcome>>
  >();
  state.respondSearch = (query) => {
    const wait = deferred<SearchPageOutcome>();
    waits.set(query, wait);
    return wait.promise;
  };
  const display = new Set<string>();
  const searched = () => state.searches.map((search) => search.query);

  // 取得 A は [C1, C2, C3]、選び直しで始まった取得 B は [C2, C3, C4]。A が C1 を確かめている最中に B が始まる
  const a = fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2"), checkPick("C3")],
    display,
  );
  assert.deepEqual(searched(), [checkQuery("C1")]);
  const b = fetchers.fetchChecks(
    [checkPick("C2"), checkPick("C3"), checkPick("C4")],
    display,
  );
  const bSeen = watchFinish(b, state);
  // B は C2 を確かめる（C1 は組に無い）
  assert.deepEqual(searched(), [checkQuery("C1"), checkQuery("C2")]);

  // A が C1 を終えて続きに進む：C2 は B が確かめている最中なので飛ばして、C3 を確かめる
  waits.get(checkQuery("C1"))?.resolve(okPage());
  await flush();
  assert.deepEqual(searched(), [
    checkQuery("C1"),
    checkQuery("C2"),
    checkQuery("C3"),
  ]);

  // B が C2 を終えて続きに進む：C3 は A が確かめている最中、C4 は4つ目なので出さない。
  // B は、A が C3 の結果を保存するまで終わらない（画面は、残っている最後の取得が終わった時点で保存を読み直す。
  // A は選び直しで古くなっていて、画面に反映されないため、C3 の結果は B の終わりに見えるようにする）
  waits.get(checkQuery("C2"))?.resolve(okPage());
  await flush();
  assert.equal(state.searches.length, 3);
  assert.equal(bSeen.finished, false);
  waits.get(checkQuery("C3"))?.resolve(okPage());
  assert.deepEqual(await Promise.all([a, b]), [
    { kind: "ok", value: null },
    { kind: "ok", value: null },
  ]);

  // 同じ会話の検索は1回ずつ。結果は3つとも保存してあり、B が終わった時点で、もう保存されている
  const saved = [
    checkPick("C1").key,
    checkPick("C2").key,
    checkPick("C3").key,
  ].sort();
  assert.equal(state.searches.length, 3);
  assert.deepEqual(Object.keys(state.checks).sort(), saved);
  assert.deepEqual(bSeen.checks, saved);
});

test("個別の確かめ：前の表示の確かめが続いている間に開いた表示は、その会話を重ねて検索しない。終わって保存されたあとは、検索しない", async () => {
  const { state, fetchers } = setup();
  const waits = new Map<
    string,
    ReturnType<typeof deferred<SearchPageOutcome>>
  >();
  state.respondSearch = (query) => {
    const wait = deferred<SearchPageOutcome>();
    waits.set(query, wait);
    return wait.promise;
  };
  const searched = () => state.searches.map((search) => search.query);

  // 前の表示が C1 を確かめている最中に閉じた（取得は最後まで続く）。新しい表示は、この表示の分を空から持つ
  const first = new Set<string>();
  const previous = fetchers.fetchChecks([checkPick("C1")], first);
  const second = new Set<string>();
  const current = fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2")],
    second,
  );
  const currentSeen = watchFinish(current, state);
  // 新しい表示は、確かめている最中の C1 を飛ばして C2 だけ確かめる。C1 は新しい表示の分に数えない
  assert.deepEqual(searched(), [checkQuery("C1"), checkQuery("C2")]);
  assert.deepEqual([...second], ["C2"]);

  // 新しい表示は C2 を終えても、前の表示が C1 の結果を保存するまで終わらない
  // （画面は終わった時点で保存を読み直すので、新しい表示にも C1 の結果が見えるようにする）
  waits.get(checkQuery("C2"))?.resolve(okPage());
  await flush();
  assert.equal(currentSeen.finished, false);
  waits.get(checkQuery("C1"))?.resolve(okPage());
  await Promise.all([previous, current]);
  assert.equal(state.searches.length, 2);
  assert.deepEqual(
    currentSeen.checks,
    [checkPick("C1").key, checkPick("C2").key].sort(),
  );

  // 保存されたので、3つ目の表示は検索しない
  await fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2")],
    new Set<string>(),
  );
  assert.equal(state.searches.length, 2);
});

test("個別の確かめ：待つのは、自分の組にある会話を別の取得が確かめているときだけ。組に無い会話の確かめは待たずに終わる", async () => {
  const { state, fetchers } = setup();
  const waits = new Map<
    string,
    ReturnType<typeof deferred<SearchPageOutcome>>
  >();
  state.respondSearch = (query) => {
    const wait = deferred<SearchPageOutcome>();
    waits.set(query, wait);
    return wait.promise;
  };

  // 前の表示が C1 を確かめている最中に、新しい表示が [C2] で始まる（C1 は組に無い）
  const previous = fetchers.fetchChecks([checkPick("C1")], new Set<string>());
  const current = fetchers.fetchChecks([checkPick("C2")], new Set<string>());
  const currentSeen = watchFinish(current, state);
  waits.get(checkQuery("C2"))?.resolve(okPage());
  await flush();
  // C1 の確かめが続いていても、新しい表示は C2 を終えたら終わる
  assert.equal(currentSeen.finished, true);
  assert.deepEqual(currentSeen.checks, [checkPick("C2").key]);

  waits.get(checkQuery("C1"))?.resolve(okPage());
  await previous;
});

test("個別の確かめ：待っていた別の取得の確かめが失敗したら、この表示の分が残っていれば、選び直して自分で確かめる", async () => {
  const { state, fetchers } = setup();
  const waits = new Map<
    string,
    ReturnType<typeof deferred<SearchPageOutcome>>
  >();
  state.respondSearch = (query) => {
    const wait = deferred<SearchPageOutcome>();
    waits.set(query, wait);
    return wait.promise;
  };

  // 前の表示が C1 を確かめている最中に、新しい表示が [C1, C2] で始まり、C2 を確かめる
  const previous = fetchers.fetchChecks([checkPick("C1")], new Set<string>());
  const second = new Set<string>();
  const current = fetchers.fetchChecks(
    [checkPick("C1"), checkPick("C2")],
    second,
  );
  waits.get(checkQuery("C2"))?.resolve(okPage());
  await flush();
  assert.equal(state.searches.length, 2);

  // 前の表示の C1 が失敗した：保存されていないので、新しい表示が C1 を選び直して確かめる
  waits.get(checkQuery("C1"))?.resolve(errorPage("検索に失敗しました"));
  await flush();
  assert.deepEqual(
    state.searches.map((search) => search.query),
    [checkQuery("C1"), checkQuery("C2"), checkQuery("C1")],
  );
  assert.deepEqual([...second], ["C2", "C1"]);
  waits.get(checkQuery("C1"))?.resolve(okPage());
  assert.deepEqual(await Promise.all([previous, current]), [
    { kind: "failed", message: "検索に失敗しました" },
    { kind: "ok", value: null },
  ]);
  assert.deepEqual(
    Object.keys(state.checks).sort(),
    [checkPick("C1").key, checkPick("C2").key].sort(),
  );
});

test("個別の確かめ：止めていて出せなかった会話は、出した分に数えない。検索に出して失敗した会話は数える。失敗しても確かめている最中の印は外れる", async () => {
  const { state, fetchers } = setup();
  const display = new Set<string>();

  // 止めている間：検索せず、出した分にも数えない
  const pause: Pause = { until: NOW + 20_000, cause: "rate_limited" };
  state.pauses.set("search", pause);
  assert.deepEqual(await fetchers.fetchChecks([checkPick("C1")], display), {
    kind: "paused",
    pause,
  });
  assert.equal(state.searches.length, 0);
  assert.equal(display.size, 0);

  // 期限が過ぎて検索したが、失敗した：出した分に数える（この表示では出し直さない）
  state.now = NOW + 20_000;
  state.respondSearch = () => Promise.resolve(errorPage("検索に失敗しました"));
  assert.deepEqual(await fetchers.fetchChecks([checkPick("C1")], display), {
    kind: "failed",
    message: "検索に失敗しました",
  });
  assert.deepEqual([...display], ["C1"]);
  await fetchers.fetchChecks([checkPick("C1")], display);
  assert.equal(state.searches.length, 1);

  // 確かめている最中の印は外れているので、新しい表示は同じ会話をまた確かめられる
  state.respondSearch = () => Promise.resolve(okPage());
  await fetchers.fetchChecks([checkPick("C1")], new Set<string>());
  assert.equal(state.searches.length, 2);
});

// ---- 既読位置 --------------------------------------------------------------------------

test("既読位置：取り直す会話は、実行の直前の保存から選ぶ。新鮮なものは飛ばし、1回20会話まで", async () => {
  const { state, fetchers } = setup();
  state.lastReads.set("C0", { lastRead: tsAgo(100), at: NOW - 60_000 });
  const wanted = ids(30);
  const round = await fetchers.refreshLastReads(wanted, false);
  // C0 は3分以内なので飛ばし、C1 から20会話
  assert.deepEqual(state.lastReadCalls, [wanted.slice(1, 21)]);
  assert.equal(round.stop, undefined);
  // 取れたものは、いつ取ったかを付けて保存される。C0 の古い値はそのまま残る
  assert.equal(state.lastReads.get("C1")?.at, NOW);
  assert.equal(state.lastReads.get("C0")?.at, NOW - 60_000);
  assert.equal(round.lastReads.size, 21);
});

test("既読位置：⌘R（force）のときは、新鮮な会話も取り直す。取る会話が無ければ、Slack API を呼ばない", async () => {
  const { state, fetchers } = setup();
  state.lastReads.set("C1", { lastRead: tsAgo(100), at: NOW - 1_000 });
  await fetchers.refreshLastReads(["C1"], false);
  assert.equal(state.lastReadCalls.length, 0);
  await fetchers.refreshLastReads(["C1"], true);
  assert.deepEqual(state.lastReadCalls, [["C1"]]);
  await fetchers.refreshLastReads([], true);
  assert.equal(state.lastReadCalls.length, 1);
});

test("既読位置：取れたものは保存し、参加していない・見えない会話は null で保存する。error は保存しない", async () => {
  const { state, fetchers } = setup();
  state.respondLastReads = () =>
    Promise.resolve({
      kind: "ok",
      rows: [
        lastReadRow("C1", tsAgo(100), null),
        lastReadRow("C2", null, "no_last_read"),
        lastReadRow("C3", null, "not_visible"),
        lastReadRow("C4", null, "error"),
      ],
    });
  const round = await fetchers.refreshLastReads(
    ["C1", "C2", "C3", "C4"],
    false,
  );
  assert.equal(round.stop, undefined);
  assert.deepEqual(
    [...state.lastReads].sort(),
    [
      ["C1", { lastRead: tsAgo(100), at: NOW }],
      ["C2", { lastRead: null, at: NOW }],
      ["C3", { lastRead: null, at: NOW }],
    ].sort(),
  );
  assert.equal(state.pauses.size, 0);
});

test("既読位置：rate_limited は保存せず、retryAfter の秒数だけ、既読位置の取得だけを止める。検索は止まらない", async () => {
  const { state, fetchers } = setup();
  state.respondLastReads = () =>
    Promise.resolve({
      kind: "ok",
      rows: [
        lastReadRow("C1", tsAgo(100), null),
        lastReadRow("C2", null, "rate_limited", 45),
        lastReadRow("C3", null, "rate_limited", 90),
      ],
    });
  const round = await fetchers.refreshLastReads(["C1", "C2", "C3"], false);
  assert.deepEqual(round.stop, {
    kind: "paused",
    pause: { until: NOW + 90_000, cause: "rate_limited" },
  });
  // rate_limited の会話は保存しない（60分「判定できない」にしない）
  assert.deepEqual([...state.lastReads.keys()], ["C1"]);
  // 止めたのは既読位置の取得（last-read）だけ。検索（search）の期限は書かない
  assert.deepEqual(state.pauseWrites, [
    {
      gate: "last-read",
      pause: { until: NOW + 90_000, cause: "rate_limited" },
    },
  ]);
  assert.equal(state.pauses.has("search"), false);

  // 既読位置の取得を止めている間も、検索は動く（自分宛て・お気に入り）
  await fetchers.fetchMentions(true);
  assert.equal(state.searches.length, 2);
  await fetchers.fetchFavorites(["C1"], true);
  assert.equal(state.searches.length, 3);

  // 止めている間は、既読位置を取り直さない（⌘R でも）。期限が過ぎれば取る
  state.lastReadCalls.length = 0;
  for (const force of [false, true]) {
    const paused = await fetchers.refreshLastReads(["C1", "C2", "C3"], force);
    assert.equal(paused.stop?.kind, "paused");
  }
  assert.equal(state.lastReadCalls.length, 0);
  state.now = NOW + 90_000;
  await fetchers.refreshLastReads(["C2", "C3"], false);
  assert.equal(state.lastReadCalls.length, 1);
});

test("既読位置：呼び出し全体が時間切れなら、既読位置の取得を30秒止める。認証の失敗は止めずにエラー。どちらも保存しない", async () => {
  const timeout = setup();
  timeout.state.respondLastReads = () =>
    Promise.resolve({
      kind: "failed",
      failure: {
        kind: "timeout",
        message: "既読位置の取得が 30 秒以内に終わらず止めました",
        pause: { until: NOW + 30_000, cause: "timeout" },
      },
    });
  const round = await timeout.fetchers.refreshLastReads(["C1"], false);
  assert.deepEqual(round.stop, {
    kind: "paused",
    pause: { until: NOW + 30_000, cause: "timeout" },
  });
  assert.equal(timeout.state.lastReadSaves, 0);
  assert.deepEqual(timeout.state.pauseWrites, [
    { gate: "last-read", pause: { until: NOW + 30_000, cause: "timeout" } },
  ]);
  assert.equal(timeout.state.pauses.has("search"), false);

  const auth = setup();
  auth.state.respondLastReads = () =>
    Promise.resolve({
      kind: "failed",
      failure: {
        kind: "error",
        message: "An API error occurred: token_expired",
      },
    });
  const failed = await auth.fetchers.refreshLastReads(["C1"], false);
  assert.deepEqual(failed.stop, {
    kind: "failed",
    message: "An API error occurred: token_expired",
  });
  assert.equal(auth.state.pauses.size, 0);
  assert.equal(auth.state.lastReadSaves, 0);
});

test("既読位置：取り直しは1回ずつ順に行い、前の回が保存した会話は、次の回が選び直さない（開いたときの処理が2回走っても、同じ会話を重ねて取らない）", async () => {
  const { state, fetchers } = setup();
  const waiting = deferred<LastReadsOutcome>();
  let first = true;
  state.respondLastReads = (requested) => {
    if (first) {
      first = false;
      return waiting.promise;
    }
    return Promise.resolve({
      kind: "ok",
      rows: requested.map((id) => lastReadRow(id, tsAgo(10), null)),
    });
  };

  const a = fetchers.refreshLastReads(["C1", "C2"], false);
  const b = fetchers.refreshLastReads(["C1", "C2", "C3"], false);
  await flush();
  // 1回目の結果が出るまで、2回目は始まらない
  assert.deepEqual(state.lastReadCalls, [["C1", "C2"]]);

  waiting.resolve({
    kind: "ok",
    rows: ["C1", "C2"].map((id) => lastReadRow(id, tsAgo(10), null)),
  });
  await Promise.all([a, b]);
  // 2回目は、1回目が保存した C1・C2 を取り直さず、新しい C3 だけを取る
  assert.deepEqual(state.lastReadCalls, [["C1", "C2"], ["C3"]]);
});

test("既読位置：取っている間に会話の既読位置が忘れられたら（行を開いた）、保存の直前に読み直すので、古い値で戻さない", async () => {
  const { state, fetchers } = setup();
  state.lastReads.set("C9", { lastRead: tsAgo(500), at: NOW - 10 * 60_000 });
  const waiting = deferred<LastReadsOutcome>();
  state.respondLastReads = () => waiting.promise;

  const round = fetchers.refreshLastReads(["C1"], false);
  await flush();
  // 取っている間に、C9 の会話を開いて、既読位置を忘れた
  state.lastReads.delete("C9");
  waiting.resolve({ kind: "ok", rows: [lastReadRow("C1", tsAgo(10), null)] });
  await round;
  assert.deepEqual([...state.lastReads.keys()], ["C1"]);
});

test("既読位置：取っている会話そのものを取っている間に忘れたら（行を開いた）、その回の結果では保存しない。次の取り直しで取り直す", async () => {
  const { state, fetchers } = setup();
  // C1・C2 は取り直す時期（3分を過ぎている）。C3 は新鮮
  for (const id of ["C1", "C2"]) {
    state.lastReads.set(id, { lastRead: tsAgo(500), at: NOW - 10 * 60_000 });
  }
  state.lastReads.set("C3", { lastRead: tsAgo(500), at: NOW - 1_000 });
  const waiting = deferred<LastReadsOutcome>();
  state.respondLastReads = () => waiting.promise;

  const round = fetchers.refreshLastReads(["C1", "C2", "C3"], false);
  await flush();
  assert.deepEqual(state.lastReadCalls, [["C1", "C2"]]);
  // 取っている間に、C1 の行を開いて、既読位置を忘れた。Slack が返すのは、開く前の値
  forget(state, "C1");
  waiting.resolve({
    kind: "ok",
    rows: [
      lastReadRow("C1", tsAgo(500), null),
      lastReadRow("C2", tsAgo(20), null),
    ],
  });
  const result = await round;

  // C1 は開く前の値なので保存しない（保存すると、新しい値として3分持たれ、取り直されない）。C2 は保存する
  assert.deepEqual([...state.lastReads].map(([id]) => id).sort(), ["C2", "C3"]);
  assert.equal(result.lastReads.has("C1"), false);
  assert.equal(state.lastReads.get("C2")?.lastRead, tsAgo(20));

  // 次の取り直しは、C1 だけを取り直す（C2・C3 は新鮮）
  state.now = NOW + 1_000;
  state.respondLastReads = (ids) =>
    Promise.resolve({
      kind: "ok",
      rows: ids.map((id) => lastReadRow(id, tsAgo(5), null)),
    });
  await fetchers.refreshLastReads(["C1", "C2", "C3"], false);
  assert.deepEqual(state.lastReadCalls[1], ["C1"]);
  assert.equal(state.lastReads.get("C1")?.lastRead, tsAgo(5));
});

test("会話の行を開いたとき（人の行は、その人との DM の会話）も、既読位置を忘れる。取っている間に開いても、開く前の値で戻さない", async () => {
  const { state, fetchers } = setup();
  // 自分宛て：チャンネル C1 と、人 U2 との DM（会話 ID は D1）
  const mine = [
    hit("C1", tsAgo(60)),
    hit("D1", tsAgo(50), {
      channelKind: "im",
      channelName: "U2",
      mentionsSelf: false,
    }),
  ];
  for (const id of ["C1", "D1"]) {
    state.lastReads.set(id, { lastRead: tsAgo(500), at: NOW - 10 * 60_000 });
  }
  const waiting = deferred<LastReadsOutcome>();
  state.respondLastReads = () => waiting.promise;
  const round = fetchers.refreshLastReads(["C1", "D1"], false);
  await flush();

  // 取っている間に、人の行（U2）とチャンネルの行（C1）を開いた。人の行は DM の会話 ID に対応させる
  const opened = [
    ...conversationsOfRow({ id: "U2", isPerson: true }, mine),
    ...conversationsOfRow({ id: "C1", isPerson: false }, mine),
  ];
  assert.deepEqual(opened, ["D1", "C1"]);
  forget(state, ...opened);
  waiting.resolve({
    kind: "ok",
    rows: [
      lastReadRow("C1", tsAgo(500), null),
      lastReadRow("D1", tsAgo(500), null),
    ],
  });
  await round;
  // どちらも開く前の値なので、保存しない
  assert.equal(state.lastReads.size, 0);

  // 次の取り直しで、2つとも取り直す
  state.now = NOW + 1_000;
  state.respondLastReads = (ids) =>
    Promise.resolve({
      kind: "ok",
      rows: ids.map((id) => lastReadRow(id, tsAgo(5), null)),
    });
  await fetchers.refreshLastReads(["C1", "D1"], false);
  assert.deepEqual(state.lastReadCalls[1], ["C1", "D1"]);
  assert.equal(state.lastReads.get("D1")?.lastRead, tsAgo(5));
});

test("既読位置：取り直しを始める前に忘れた会話は、その回の結果を保存する（開いたあとに取った値だから）", async () => {
  const { state, fetchers } = setup();
  // 開いた（忘れた）のは、取り直しを始める1秒前
  state.now = NOW - 1_000;
  forget(state, "C1");
  state.now = NOW;
  const round = await fetchers.refreshLastReads(["C1"], false);
  assert.equal(state.lastReads.get("C1")?.lastRead, tsAgo(10));
  assert.equal(round.lastReads.has("C1"), true);
});

test("既読位置：前の回が失敗しても、次の回は始まる", async () => {
  const { state, fetchers } = setup();
  let calls = 0;
  state.respondLastReads = (requested) => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("想定外の失敗"))
      : Promise.resolve({
          kind: "ok",
          rows: requested.map((id) => lastReadRow(id, tsAgo(10), null)),
        });
  };
  const a = fetchers.refreshLastReads(["C1"], false);
  const b = fetchers.refreshLastReads(["C2"], false);
  await assert.rejects(a, /想定外の失敗/);
  const round = await b;
  assert.equal(round.lastReads.has("C2"), true);
});
