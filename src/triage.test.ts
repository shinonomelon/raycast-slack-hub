import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTs, type Hit } from "./hits.ts";
import { LAST_READ_TIMEOUT_MS } from "./search-gate.ts";
import type { LastReadRow } from "./types.ts";
import {
  applyChecks,
  cappedBeforeOf,
  chunkFavorites,
  decideLastReadStore,
  favoriteSearchQuery,
  favoritesWithResult,
  freshFavoriteChunks,
  handledKeys,
  isCountUnknown,
  judgeReadState,
  keepFetchedLastReads,
  lastReadMap,
  LAST_READ_KEEP_MS,
  LAST_READ_OPTIONS,
  lastReadsForTags,
  markHandled,
  MARK_TTL_MS,
  matchesView,
  mentionQueries,
  mentionsOf,
  mergeHits,
  mineCompleteFrom,
  nextCheck,
  NOTHING_COMPLETE_TS,
  NOTHING_SHOWN,
  openConversations,
  parseChecks,
  parseFavoriteEntry,
  parseLastReads,
  parseMarks,
  parseOpened,
  parseTriageEntry,
  pickUnknownChecks,
  planRefresh,
  pruneChecks,
  pruneLastReads,
  pruneMarks,
  pruneOpened,
  rememberShown,
  searchAfterDate,
  sinceTs,
  summarizeCheck,
  summarizeFavoriteUnread,
  summarizeFavorites,
  toFavoriteHit,
  toggleHandled,
  triageRows,
  truncatedByCap,
  tsOfTime,
  unknownCheckKey,
  unknownCheckQuery,
  unmarkHandled,
  wantedConversations,
  type CachedLastRead,
  type FavoriteChunk,
  type FavoriteUnread,
  type Opened,
  type Shown,
} from "./triage.ts";

const SELF = "U0000000013";

const hit = (channelId: string, ts: string, extra: Partial<Hit> = {}): Hit => ({
  key: `${channelId}:${ts}`,
  channelId,
  ts,
  permalink: "",
  text: "",
  channelKind: "channel",
  mentionsSelf: false,
  ...extra,
});

test("after: の日付は手元の日付で、1日多くさかのぼる", () => {
  // 2026年10月4日の手元の時刻0時30分から7日 → 9月26日より後を検索する
  assert.equal(searchAfterDate(new Date(2026, 9, 4, 0, 30), 7), "2026-09-26");
  // 2026-10-04T00:00:00Z は 1791072000。その1日前
  assert.equal(
    sinceTs(new Date("2026-10-04T00:00:00Z"), 1),
    "1790985600.000000",
  );
});

test("同じメッセージは1件にまとめ、新しい順に並べる", () => {
  const merged = mergeHits([
    [hit("C1", "1700000002.000000"), hit("C1", "1700000001.000000")],
    [
      hit("C1", "1700000002.000000", { mentionsSelf: true }),
      hit("D1", "1700000003.000000"),
    ],
  ]);
  assert.deepEqual(
    merged.map((h) => h.key),
    ["D1:1700000003.000000", "C1:1700000002.000000", "C1:1700000001.000000"],
  );
});

test("既読位置より新しければ未読、同じか古ければ既読。スレッド返信と未確認は判定しない", () => {
  const none = new Set<string>();
  const top = hit("C1", "1700000002.000000");
  assert.equal(judgeReadState(top, "1700000001.000000", none), "unread");
  assert.equal(judgeReadState(top, "1700000002.000000", none), "read");
  assert.equal(judgeReadState(top, "1700000003.000000", none), "read");
  assert.equal(judgeReadState(top, null, none), "unknown");
  assert.equal(judgeReadState(top, undefined, none), "unknown");
  const reply = hit("C1", "1700000002.000000", {
    threadTs: "1700000000.000000",
  });
  assert.equal(judgeReadState(reply, "1700000009.000000", none), "thread");
  assert.equal(
    judgeReadState(top, "1700000001.000000", new Set([top.key])),
    "handled",
  );
});

test("未読のみには判定できないものも残し、自分宛てのみはメンションと DM を残す", () => {
  const h = hit("C1", "1.000001");
  assert.equal(matchesView(h, "unread", "unread"), true);
  assert.equal(matchesView(h, "thread", "unread"), true);
  assert.equal(matchesView(h, "unknown", "unread"), true);
  assert.equal(matchesView(h, "read", "unread"), false);
  assert.equal(matchesView(h, "handled", "unread"), false);
  assert.equal(matchesView(h, "read", "mine"), false);
  assert.equal(matchesView({ ...h, mentionsSelf: true }, "read", "mine"), true);
  assert.equal(matchesView({ ...h, channelKind: "im" }, "read", "mine"), true);
  assert.equal(matchesView({ ...h, channelKind: "mpim" }, "read", "all"), true);
});

test("既読位置を取り直す会話は、重複を除き、新鮮なものを飛ばし、上限で切る", () => {
  const now = 1_000_000;
  const cached = new Map<string, CachedLastRead>([
    ["C1", { lastRead: "1.0", at: now - 60_000 }], // 1分前 → 新鮮
    ["C2", { lastRead: "1.0", at: now - 5 * 60_000 }], // 5分前 → 古い
    ["C3", { lastRead: null, at: now - 30 * 60_000 }], // 取れなかった会話は60分持つ
  ]);
  const options = { ttlMs: 3 * 60_000, nullTtlMs: 60 * 60_000, budget: 2 };
  assert.deepEqual(
    planRefresh(["C1", "C2", "C2", "C3", "C4", "C5"], cached, now, options),
    ["C2", "C4"],
  );
});

test("お気に入りの未読数は、スレッド返信と自分の投稿を数えず、最新順に並べる", () => {
  const lastRead = new Map([
    ["C1", "1700000001.000000"],
    ["C2", "1700000005.000000"],
    ["C3", "1700000001.000000"],
  ]);
  const hits = [
    hit("C1", "1700000003.000000"),
    hit("C1", "1700000002.000000"),
    hit("C1", "1700000002.500000", { threadTs: "1700000000.000000" }), // スレッド返信
    hit("C1", "1700000004.000000", { userId: SELF }), // 自分の投稿
    hit("C1", "1700000000.500000"), // 既読
    hit("C2", "1700000009.000000"),
  ];
  const result = summarizeFavoriteUnread(hits, lastRead, SELF, {
    truncatedIds: new Set(["C2"]),
    horizonTs: "1700000000.000000",
  });
  assert.deepEqual(result, [
    {
      channelId: "C2",
      count: 1,
      latestTs: "1700000009.000000",
      truncated: true,
    },
    {
      channelId: "C1",
      count: 2,
      latestTs: "1700000003.000000",
      truncated: false,
    },
  ]);
});

test("既読位置が検索した期間より古い会話は、期間内に未読が無くても件数不明として残す", () => {
  // 既読位置は9月28日、検索したのは10月3日から。間（9月29日〜）の未読は見えていない
  const lastRead = new Map([["C1", "1790579127.558919"]]);
  const result = summarizeFavoriteUnread([], lastRead, SELF, {
    truncatedIds: new Set(),
    horizonTs: "1790985600.000000",
  });
  assert.deepEqual(result, [{ channelId: "C1", count: 0, truncated: true }]);
});

test("印は期限内のものだけ残す", () => {
  const now = 1_000_000;
  assert.deepEqual(
    pruneMarks({ a: now - 10, b: now - 100, c: now - 1000 }, now, 100),
    { a: now - 10, b: now - 100 },
  );
});

test("上限で切れたまとめ検索では、取れた中で一番古い投稿より前に既読位置がある会話だけ件数が下限になる", () => {
  const lastRead = new Map([
    ["C1", "1700000005.000000"], // 取れた範囲の中に既読位置がある → 件数は正確
    ["C2", "1700000001.000000"], // 取れた中で一番古い投稿より前 → 下限
  ]);
  const hits = [hit("C1", "1700000009.000000"), hit("C2", "1700000003.000000")];
  assert.deepEqual(
    [...truncatedByCap(["C1", "C2", "C3"], lastRead, hits)],
    ["C2"],
  );
});

test("自分宛ての検索が切れたときの境目：切れた検索の、取れた中で一番古い投稿の ts。切れていない検索は見ない", () => {
  const capped = [
    hit("C1", "1700000900.000000"),
    hit("C1", "1700000300.000000"),
    hit("C1", "1700000600.000000"),
  ];
  // 切れていない検索に、もっと古い投稿があっても境目にしない（切れていないので、古い側もそろっている）
  const complete = [hit("D1", "1700000100.000000")];

  assert.equal(cappedBeforeOf([]), undefined);
  assert.equal(
    cappedBeforeOf([
      { hits: capped, capped: false },
      { hits: complete, capped: false },
    ]),
    undefined,
  );
  assert.equal(
    cappedBeforeOf([
      { hits: capped, capped: true },
      { hits: complete, capped: false },
    ]),
    "1700000300.000000",
  );
  // 順序に関わらない
  assert.equal(
    cappedBeforeOf([
      { hits: complete, capped: false },
      { hits: capped, capped: true },
    ]),
    "1700000300.000000",
  );
});

test("自分宛ての検索が2つとも切れたら、境目は新しいほう（どちらの古い側も欠けているため）", () => {
  const a = [hit("C1", "1700000900.000000"), hit("C1", "1700000300.000000")];
  const b = [hit("D1", "1700000800.000000"), hit("D1", "1700000500.000000")];
  assert.equal(
    cappedBeforeOf([
      { hits: a, capped: true },
      { hits: b, capped: true },
    ]),
    "1700000500.000000",
  );
  assert.equal(
    cappedBeforeOf([
      { hits: b, capped: true },
      { hits: a, capped: true },
    ]),
    "1700000500.000000",
  );
});

test("自分宛ての検索が切れたのに1件も取れていないときは、どこまで揃っているか分からないので、すべての既読位置が境目より前になる", () => {
  const before = cappedBeforeOf([{ hits: [], capped: true }]);
  assert.equal(before, NOTHING_COMPLETE_TS);
  // ほかの切れた検索があっても、揃っている範囲は無い
  assert.equal(
    cappedBeforeOf([
      { hits: [hit("C1", "1700000300.000000")], capped: true },
      { hits: [], capped: true },
    ]),
    NOTHING_COMPLETE_TS,
  );
  // 期間の始まりより新しい境目なので、期間の始まりは境目に置き換わる。
  // 境目は、これから先の時刻の ts よりも後ろ（どの既読位置も境目より前になる）
  assert.equal(
    mineCompleteFrom("1700000000.000000", before),
    NOTHING_COMPLETE_TS,
  );
  assert.ok(
    compareTs(
      sinceTs(new Date("2100-01-01T00:00:00Z"), 0),
      NOTHING_COMPLETE_TS,
    ) < 0,
  );
});

test("自分宛ての結果が揃っている期間の始まりは、期間の始まりと切れた境目のうち新しいほう", () => {
  const since = "1700000000.000000";
  // 切れていない
  assert.equal(mineCompleteFrom(since, undefined), since);
  // 境目が期間の始まりより古い（切れても期間の外）
  assert.equal(mineCompleteFrom(since, "1699999000.000000"), since);
  // 境目が期間の中
  assert.equal(
    mineCompleteFrom(since, "1700000300.000000"),
    "1700000300.000000",
  );
  // 同じ
  assert.equal(mineCompleteFrom(since, since), since);
});

// ---- ここから、Hub で足した関数のテスト --------------------------------------------------

const NOW = 1_759_560_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- 印（開いた・対応済み）の付け外し ---------------------------------------------------

test("印の付け外し：印の無いメッセージに使うと付き、もう一度使うと外れる。ほかの印は動かさない", () => {
  const key = "C1:1700000001.000000";
  const marked = toggleHandled({}, key, NOW);
  assert.deepEqual(marked, { [key]: NOW });
  assert.deepEqual(toggleHandled(marked, key, NOW + 1_000), {});

  // 付けるだけ・外すだけ。ほかの印はそのまま
  const others = { "C2:1.000001": NOW - 1_000 };
  assert.deepEqual(markHandled(others, key, NOW), { ...others, [key]: NOW });
  assert.deepEqual(unmarkHandled({ ...others, [key]: NOW }, key, NOW), others);
  // 無い印を外しても何も起きない
  assert.deepEqual(unmarkHandled(others, key, NOW), others);
  // 付け直すと、付けた時刻が新しくなる（14日の数え直し）
  assert.deepEqual(markHandled(marked, key, NOW + 5_000), {
    [key]: NOW + 5_000,
  });
  // 元の印は書き換えない
  assert.deepEqual(marked, { [key]: NOW });
});

test("14日を過ぎた印は消える。ちょうど14日はまだ残る", () => {
  assert.equal(MARK_TTL_MS, 14 * DAY_MS);
  const marks = {
    old: NOW - MARK_TTL_MS - 1,
    edge: NOW - MARK_TTL_MS,
    fresh: NOW - 1_000,
  };
  assert.deepEqual([...handledKeys(marks, NOW)].sort(), ["edge", "fresh"]);
  // 付け外しのときに、期限を過ぎた印も一緒に消える
  assert.deepEqual(markHandled(marks, "new", NOW), {
    edge: marks.edge,
    fresh: marks.fresh,
    new: NOW,
  });
  assert.deepEqual(unmarkHandled(marks, "fresh", NOW), { edge: marks.edge });
  // 期限を過ぎた印のメッセージに使うと、外れるのでなく、付き直る
  assert.deepEqual(toggleHandled(marks, "old", NOW), {
    edge: marks.edge,
    fresh: marks.fresh,
    old: NOW,
  });
});

test("印が付いたメッセージは「対応済み」と判定される（ほかの判定より先）", () => {
  const reply = hit("C1", "1700000002.000000", {
    threadTs: "1700000000.000000",
  });
  const marks = toggleHandled({}, reply.key, NOW);
  assert.equal(
    judgeReadState(reply, "1700000009.000000", handledKeys(marks, NOW)),
    "handled",
  );
  // 外すと、元の判定（スレッド）に戻る
  const unmarked = toggleHandled(marks, reply.key, NOW);
  assert.equal(
    judgeReadState(reply, "1700000009.000000", handledKeys(unmarked, NOW)),
    "thread",
  );
});

// ---- 既読位置を取り直す会話 -----------------------------------------------------------

test("⌘R（force）のときは、新鮮な既読位置も取り直す。重複を除くことと上限は守る", () => {
  const now = 1_000_000;
  const cached = new Map<string, CachedLastRead>([
    ["C1", { lastRead: "1.0", at: now - 1_000 }], // 新鮮
    ["C3", { lastRead: null, at: now - 1_000 }], // 取れなかった会話も新鮮
  ]);
  const wanted = ["C1", "C2", "C2", "C3", "C4", "C5"];
  const options = { ...LAST_READ_OPTIONS, budget: 4 };
  // 普段は新鮮なものを飛ばす
  assert.deepEqual(planRefresh(wanted, cached, now, options), [
    "C2",
    "C4",
    "C5",
  ]);
  assert.deepEqual(
    planRefresh(wanted, cached, now, { ...options, force: false }),
    ["C2", "C4", "C5"],
  );
  // force は新鮮なものも選ぶ。重複は除き、上限（4）で切る。優先の順（お気に入り → 新しい順）は保つ
  assert.deepEqual(
    planRefresh(wanted, cached, now, { ...options, force: true }),
    ["C1", "C2", "C3", "C4"],
  );
});

test("既読位置の取り直しの値：1回20会話まで、3分以内のものは飛ばし、取れなかった会話は60分持つ", () => {
  assert.deepEqual(LAST_READ_OPTIONS, {
    ttlMs: 3 * 60_000,
    nullTtlMs: 60 * 60_000,
    budget: 20,
  });
  const ids = Array.from({ length: 25 }, (_, i) => `C${i}`);
  assert.equal(planRefresh(ids, new Map(), NOW, LAST_READ_OPTIONS).length, 20);
});

// ---- 既読位置の結果から、保存するものと止める期限 --------------------------------------

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

test("既読位置の結果：取れたものは保存し、参加していない・見えない会話は null で保存する（60分持つ）", () => {
  const { save, pause } = decideLastReadStore(
    [
      lastReadRow("C1", "1700000001.000000", null),
      lastReadRow("C2", null, "no_last_read"),
      lastReadRow("C3", null, "not_visible"),
    ],
    NOW,
  );
  assert.deepEqual(
    [...save],
    [
      ["C1", { lastRead: "1700000001.000000", at: NOW }],
      ["C2", { lastRead: null, at: NOW }],
      ["C3", { lastRead: null, at: NOW }],
    ],
  );
  assert.equal(pause, undefined);
  // null は60分、取れた値は3分で取り直す
  assert.deepEqual(
    planRefresh(["C1", "C2", "C3"], save, NOW + 59 * 60_000, LAST_READ_OPTIONS),
    ["C1"],
  );
  assert.deepEqual(
    planRefresh(["C1", "C2", "C3"], save, NOW + 61 * 60_000, LAST_READ_OPTIONS),
    ["C1", "C2", "C3"],
  );
});

test("既読位置の結果：rate_limited は保存せず、retryAfter の秒数（複数ならいちばん長いもの）だけ、既読位置の取得だけを止める", () => {
  const { save, pause } = decideLastReadStore(
    [
      lastReadRow("C1", "1700000001.000000", null),
      lastReadRow("C2", null, "rate_limited", 45),
      lastReadRow("C3", null, "rate_limited", 90),
      lastReadRow("C4", null, "rate_limited", 30),
    ],
    NOW,
  );
  // 取れたものだけ保存する。rate_limited の会話は保存しない（60分「判定できない」にしない）
  assert.deepEqual([...save.keys()], ["C1"]);
  assert.deepEqual(pause, {
    gate: "last-read",
    pause: { until: NOW + 90_000, cause: "rate_limited" },
  });
  // 止めるのは既読位置の取得だけ。検索の期限（search）は触らない
  assert.equal(pause?.gate, "last-read");
});

test("既読位置の結果：error・知らない理由・待つ秒数の無い rate_limited・値の無い成功は、保存せず、止めない（次に取り直す）", () => {
  const odd: LastReadRow[] = [
    lastReadRow("C1", null, "error"),
    lastReadRow("C2", null, "rate_limited"),
    lastReadRow("C3", null, "rate_limited", 0),
    lastReadRow("C4", null, "rate_limited", Number.NaN),
    {
      channelId: "C5",
      lastRead: null,
      reason: "ふしぎ",
    } as unknown as LastReadRow,
    lastReadRow("C6", null, null),
  ];
  const { save, pause } = decideLastReadStore(odd, NOW);
  assert.equal(save.size, 0);
  assert.equal(pause, undefined);
  // 空の結果も同じ
  assert.deepEqual(decideLastReadStore([], NOW), { save: new Map() });
});

test("保存した既読位置は1日だけ持つ。取れている会話だけの表も作れる", () => {
  const entries = new Map<string, CachedLastRead>([
    ["C1", { lastRead: "1.0", at: NOW - DAY_MS }],
    ["C2", { lastRead: "2.0", at: NOW - DAY_MS - 1 }],
    ["C3", { lastRead: null, at: NOW }],
  ]);
  assert.deepEqual([...pruneLastReads(entries, NOW).keys()], ["C1", "C3"]);
  assert.deepEqual(
    [...lastReadMap(entries)],
    [
      ["C1", "1.0"],
      ["C2", "2.0"],
    ],
  );
});

// ---- 検索式と、取る会話の決め方 ------------------------------------------------------

test("自分宛ての検索式：メンションと to:（自分の投稿は除く）。お気に入りのまとめ検索は複数の in:", () => {
  assert.deepEqual(mentionQueries("U0000000013", "2026-09-26"), [
    "<@U0000000013> -from:me after:2026-09-26",
    "to:<@U0000000013> -from:me after:2026-09-26",
  ]);
  assert.equal(
    favoriteSearchQuery(["C1", "G2"], "2026-09-26"),
    "in:<#C1> in:<#G2> after:2026-09-26",
  );
});

test("件数不明の会話を個別に確かめる式は、既読位置の日から（after: は、その日の前日）", () => {
  // 2026年10月1日 21時（JST）= 12:00 UTC。前日の 9月30日より後（10月1日以降）を探す
  assert.equal(
    unknownCheckQuery("C1", "1790856000.000100"),
    "in:<#C1> after:2026-09-30",
  );
  assert.equal(
    unknownCheckKey("C1", "1790856000.000100"),
    "C1:1790856000.000100",
  );
});

test("お気に入りは10会話ずつ組み分け、5つ（50会話）で切る。重複は除く", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);
  assert.deepEqual(chunkFavorites([]), []);
  assert.deepEqual(
    chunkFavorites(ids(23)).map((c) => c.length),
    [10, 10, 3],
  );
  // 50会話までが5つ。それより後のお気に入りは検索しない
  const many = chunkFavorites(ids(70));
  assert.equal(many.length, 5);
  assert.deepEqual(
    many.map((c) => c.length),
    [10, 10, 10, 10, 10],
  );
  assert.deepEqual(many.flat(), ids(50));
  // 重複は除いてから数える
  assert.deepEqual(chunkFavorites(["C1", "C1", "C2"]), [["C1", "C2"]]);
});

test("既読位置を取り直したい会話は、お気に入りを先に、そのあとに自分宛ての会話を新しい順に。重複は除く", () => {
  assert.deepEqual(
    wantedConversations(
      ["C9", "C1"],
      [{ channelId: "C1" }, { channelId: "D2" }, { channelId: "C1" }],
    ),
    ["C9", "C1", "D2"],
  );
});

// ---- お気に入りの未読 ------------------------------------------------------------

test("お気に入りに保存するのは、会話・ts・スレッドの親・送信者だけ（本文と permalink は持たない）", () => {
  const full = hit("C1", "1700000003.000000", {
    userId: "U1",
    threadTs: "1700000000.000000",
    text: "請求書を確認してください",
    permalink: "https://example.slack.com/archives/C1/p1700000003000000",
    channelName: "op_request",
    username: "someone",
  });
  const slim = toFavoriteHit(full);
  assert.deepEqual(slim, {
    channelId: "C1",
    ts: "1700000003.000000",
    threadTs: "1700000000.000000",
    userId: "U1",
  });
  // 値の無い項目は持たない
  assert.deepEqual(Object.keys(toFavoriteHit(hit("C1", "1.000001"))), [
    "channelId",
    "ts",
  ]);
  // 保存する文字列に本文が入らない
  assert.equal(JSON.stringify(slim).includes("請求書"), false);
});

test("まとめ検索の結果と既読位置から、お気に入りの会話ごとの未読数を出す。上限で切れた検索の会話は下限になる", () => {
  const chunks: FavoriteChunk[] = [
    {
      ids: ["C1", "C2"],
      hits: [
        toFavoriteHit(hit("C1", "1700000009.000000")),
        toFavoriteHit(hit("C1", "1700000008.000000")),
        toFavoriteHit(hit("C2", "1700000007.000000")),
      ],
      // 取れた中で一番古い投稿は 07。C2 の既読位置 01 はそれより前 → 下限
      capped: true,
    },
    {
      ids: ["C3"],
      hits: [toFavoriteHit(hit("C3", "1700000006.000000"))],
      capped: false,
    },
  ];
  const lastReads = new Map([
    ["C1", "1700000007.500000"], // 取れた範囲の中に既読位置がある → 正確
    ["C2", "1700000001.000000"],
    ["C3", "1700000005.000000"],
    ["C9", "1700000000.000000"], // お気に入りでない会話は使わない
  ]);
  const summary = summarizeFavorites({
    chunks,
    favoriteIds: ["C1", "C2", "C3"],
    lastReads,
    selfId: SELF,
    horizonTs: "1700000000.000000",
  });
  assert.deepEqual(summary, [
    {
      channelId: "C1",
      count: 2,
      latestTs: "1700000009.000000",
      truncated: false,
    },
    {
      channelId: "C2",
      count: 1,
      latestTs: "1700000007.000000",
      truncated: true,
    },
    {
      channelId: "C3",
      count: 1,
      latestTs: "1700000006.000000",
      truncated: false,
    },
  ]);
});

test("件数不明（0 件で下限）の会話は、先頭から3件まで個別に確かめる。確かめた結果で、残す・替える・外すを決める", () => {
  const unknown = (channelId: string): FavoriteUnread => ({
    channelId,
    count: 0,
    truncated: true,
  });
  const summary: FavoriteUnread[] = [
    { channelId: "C0", count: 2, truncated: false },
    unknown("C1"),
    unknown("C2"),
    unknown("C3"),
    unknown("C4"),
  ];
  const lastReadById = new Map([
    ["C1", "1700000001.000000"],
    ["C2", "1700000002.000000"],
    ["C3", "1700000003.000000"],
    ["C4", "1700000004.000000"],
  ]);
  const picks = pickUnknownChecks(summary, lastReadById);
  assert.deepEqual(
    picks.map((p) => p.key),
    ["C1:1700000001.000000", "C2:1700000002.000000", "C3:1700000003.000000"],
  );

  // C1 は確かめて未読なし（外す）、C2 は未読あり（替える）、C3 以降はまだ確かめていない（件数不明のまま残す）
  const checked: FavoriteUnread = {
    channelId: "C2",
    count: 4,
    latestTs: "1700000009.000000",
    truncated: true,
  };
  assert.deepEqual(
    applyChecks(
      summary,
      { "C1:1700000001.000000": null, "C2:1700000002.000000": checked },
      lastReadById,
    ),
    [summary[0], checked, summary[3], summary[4]],
  );
  // 既読位置が進んで別のキーになった結果は使わない
  assert.deepEqual(
    applyChecks(
      [unknown("C1")],
      { "C1:1700000000.000001": null },
      lastReadById,
    ),
    [unknown("C1")],
  );
});

test("件数不明は、件数 0 で下限のときだけ。件数のある下限や、件数 0 で下限でないもの（未読が無いと分かっている）は、件数不明ではない", () => {
  const favorite = (count: number, truncated: boolean) => ({
    count,
    truncated,
  });
  assert.equal(isCountUnknown(favorite(0, true)), true);
  assert.equal(isCountUnknown(favorite(3, true)), false);
  assert.equal(isCountUnknown(favorite(0, false)), false);
  assert.equal(isCountUnknown(favorite(3, false)), false);
});

test("個別に確かめる会話の選び方：保存してある結果・この表示で出した会話・確かめている最中の会話は選ばず、この表示で3会話に達したらもう選ばない", () => {
  const pick = (id: string, lastRead = "1700000001.000000") => ({
    id,
    lastRead,
    key: unknownCheckKey(id, lastRead),
  });
  const picks = [pick("C1"), pick("C2"), pick("C3")];
  const none = new Set<string>();
  const idOf = (params: Partial<Parameters<typeof nextCheck>[0]>) =>
    nextCheck({
      picks,
      requested: none,
      checking: none,
      done: {},
      ...params,
    })?.id;

  // 何も出していなければ先頭
  assert.equal(idOf({}), "C1");
  // 保存してある結果がある会話は選ばない（検索しないので、上限にも数えない）
  assert.equal(idOf({ done: { [pick("C1").key]: null } }), "C2");
  // この表示で出した会話は選ばない。既読位置が進んで結果のキーが違う会話も、出し直さない
  assert.equal(idOf({ requested: new Set(["C1"]) }), "C2");
  assert.equal(
    nextCheck({
      picks: [pick("C1", "1700000009.000000")],
      requested: new Set(["C1"]),
      checking: none,
      done: {},
    }),
    undefined,
  );
  // 確かめている最中の会話は選ばない
  assert.equal(idOf({ checking: new Set(["C1", "C2"]) }), "C3");
  // 選べる会話が無ければ undefined
  assert.equal(
    idOf({
      done: { [pick("C1").key]: null },
      requested: new Set(["C2"]),
      checking: new Set(["C3"]),
    }),
    undefined,
  );
  assert.equal(idOf({ picks: [] }), undefined);

  // この表示で3会話に達したら、選べる会話があっても選ばない。2会話までなら選ぶ
  const more = [pick("C4"), ...picks];
  assert.equal(idOf({ picks: more, requested: new Set(["C1", "C2"]) }), "C4");
  assert.equal(
    idOf({ picks: more, requested: new Set(["C1", "C2", "C3"]) }),
    undefined,
  );
  // 上限は引数で変えられる
  assert.equal(
    nextCheck({
      picks: more,
      requested: new Set(["C1"]),
      checking: none,
      done: {},
      limit: 1,
    }),
    undefined,
  );
});

test("個別に確かめた結果：未読が無ければ null。古い順に取って上限で切れたら下限になる。自分の投稿とスレッド返信は数えない", () => {
  const base = { id: "C1", lastRead: "1700000005.000000", selfId: SELF };
  assert.equal(summarizeCheck({ ...base, hits: [], capped: false }), null);
  assert.deepEqual(
    summarizeCheck({
      ...base,
      hits: [
        toFavoriteHit(hit("C1", "1700000006.000000")),
        toFavoriteHit(hit("C1", "1700000007.000000", { userId: SELF })),
        toFavoriteHit(
          hit("C1", "1700000008.000000", { threadTs: "1700000000.000000" }),
        ),
        toFavoriteHit(hit("C1", "1700000004.000000")),
      ],
      capped: false,
    }),
    {
      channelId: "C1",
      count: 1,
      latestTs: "1700000006.000000",
      truncated: false,
    },
  );
  // 上限で切れたら、取れていない新しい側に未読があるので、下限
  assert.equal(
    summarizeCheck({
      ...base,
      hits: [toFavoriteHit(hit("C1", "1700000006.000000"))],
      capped: true,
    })?.truncated,
    true,
  );
  // 未読が無くても、上限で切れていれば件数不明のまま（0 件で下限）
  assert.deepEqual(summarizeCheck({ ...base, hits: [], capped: true }), {
    channelId: "C1",
    count: 0,
    truncated: true,
  });
});

// ---- 空欄の一覧に出す自分宛ての行 ---------------------------------------------------

// 会話 ID → 既読位置の表（無ければ、まだ取っていない）と、印のある key から、判定する関数を作る
const judger = (
  lastReads: Record<string, string | null | undefined>,
  handled: string[] = [],
) => {
  const marks = new Set(handled);
  return (h: Hit) => judgeReadState(h, lastReads[h.channelId], marks);
};
const keysOf = (rows: { hit: Hit }[]) => rows.map((r) => r.hit.key);
const statesOf = (rows: { hit: Hit; state: string }[]) =>
  rows.map((r) => `${r.hit.channelId}:${r.state}`);

const unreadMine = hit("C1", "1700000009.000000"); // C1 の既読位置 06 より新しい → 未読
const threadReply = hit("C2", "1700000008.000000", {
  threadTs: "1700000000.000000",
}); // スレッド返信
const noLastRead = hit("C3", "1700000007.000000"); // 既読位置がまだ分からない
const alreadyRead = hit("C4", "1700000006.000000"); // 既読
const olderRead = hit("C1", "1700000005.000000"); // 既読
const mine = [unreadMine, threadReply, noLastRead, alreadyRead, olderRead];

test("空欄の一覧には、開いたときの判定で未読・スレッド・判定できないものだけを新しい順に出す。既読と印の付いたものは出さない", () => {
  const judge = judger({
    C1: "1700000006.000000",
    C2: "1700000010.000000",
    C4: "1700000010.000000",
  });
  assert.deepEqual(statesOf(triageRows(mine, judge, NOTHING_SHOWN)), [
    "C1:unread",
    "C2:thread",
    "C3:unknown",
  ]);
  // 開いた・対応済みの印が付いたものは外れる（スレッド返信も、印が付けば外れる）
  assert.deepEqual(
    statesOf(
      triageRows(
        mine,
        judger({ C1: "1700000006.000000", C2: "1700000010.000000" }, [
          unreadMine.key,
          threadReply.key,
        ]),
        NOTHING_SHOWN,
      ),
    ),
    ["C3:unknown", "C4:unknown"],
  );
  // 入力の順に関わらず、新しい順
  assert.deepEqual(
    keysOf(triageRows([...mine].reverse(), judger({}), NOTHING_SHOWN)),
    mine.map((h) => h.key),
  );
});

test("スレッド返信は、既読位置に関わらず「スレッド」で、印が付くまで空欄の一覧に残る", () => {
  const future = judger({ C2: "1799999999.000000" });
  assert.equal(future(threadReply), "thread");
  assert.deepEqual(statesOf(triageRows([threadReply], future, NOTHING_SHOWN)), [
    "C2:thread",
  ]);
  const handled = judger({ C2: "1799999999.000000" }, [threadReply.key]);
  assert.deepEqual(triageRows([threadReply], handled, NOTHING_SHOWN), []);
});

test("開いている間に既読になった行は、印だけ変えて残る。⌘R のあとと次に開いたときに消える", () => {
  // 開いたとき
  const atOpen = judger({
    C1: "1700000006.000000",
    C2: "1700000010.000000",
    C4: "1700000010.000000",
  });
  const rowsAtOpen = triageRows(mine, atOpen, NOTHING_SHOWN);
  assert.deepEqual(statesOf(rowsAtOpen), [
    "C1:unread",
    "C2:thread",
    "C3:unknown",
  ]);
  let shown: Shown = rememberShown(NOTHING_SHOWN, rowsAtOpen);

  // 開いている間に、C1 を Slack で読み、C3 の既読位置が取れて既読だった（どちらも既読になる）
  const later = judger({
    C1: "1700000010.000000",
    C2: "1700000010.000000",
    C3: "1700000010.000000",
    C4: "1700000010.000000",
  });
  const rowsLater = triageRows(mine, later, shown);
  // 消えずに、既読の印に変わって残る。もとから既読の行（C4・C1 の古い投稿）は出ない
  assert.deepEqual(statesOf(rowsLater), ["C1:read", "C2:thread", "C3:read"]);
  shown = rememberShown(shown, rowsLater);
  assert.deepEqual(
    statesOf(triageRows(mine, later, shown)),
    statesOf(rowsLater),
  );

  // 印を付ける（⌘⇧D・開いた）と、すぐ消える
  const marked = judger(
    {
      C1: "1700000010.000000",
      C2: "1700000010.000000",
      C3: "1700000010.000000",
      C4: "1700000010.000000",
    },
    [unreadMine.key],
  );
  assert.deepEqual(statesOf(triageRows(mine, marked, shown)), [
    "C2:thread",
    "C3:read",
  ]);

  // ⌘R のあと：記録を空にして、いまの判定で出し直す。既読になった行は消える
  const afterReload = triageRows(mine, later, NOTHING_SHOWN);
  assert.deepEqual(statesOf(afterReload), ["C2:thread"]);
  shown = rememberShown(NOTHING_SHOWN, afterReload);
  // そのあと、スレッドの行を含めて既読位置が進んでも、出していた行（C2）は残る
  assert.deepEqual(statesOf(triageRows(mine, later, shown)), ["C2:thread"]);

  // 次に開いたとき：記録は引き継がない。最初から、その時点の判定で出す
  assert.deepEqual(statesOf(triageRows(mine, later, NOTHING_SHOWN)), [
    "C2:thread",
  ]);
});

test("自分宛ての取り直しで検索結果から外れた行も、出していれば開いている間は残る。新しい行は足され、新しい順に並ぶ", () => {
  const judge = judger({ C1: "1700000006.000000" });
  const first = triageRows(
    [unreadMine, threadReply, noLastRead],
    judge,
    NOTHING_SHOWN,
  );
  const shown = rememberShown(NOTHING_SHOWN, first);

  // 取り直した結果に、threadReply と noLastRead が無い（上限・期間の端・削除）。新しい行 fresh が増えた
  const fresh = hit("C1", "1700000012.000000");
  const refetched = [fresh, unreadMine];
  assert.deepEqual(keysOf(triageRows(refetched, judge, shown)), [
    fresh.key,
    unreadMine.key,
    threadReply.key,
    noLastRead.key,
  ]);
  // 出していなかった行は、検索結果から外れれば消える
  assert.deepEqual(keysOf(triageRows(refetched, judge, NOTHING_SHOWN)), [
    fresh.key,
    unreadMine.key,
  ]);
  // 外れた行に印が付けば、消える
  assert.deepEqual(
    keysOf(
      triageRows(
        refetched,
        judger({ C1: "1700000006.000000" }, [threadReply.key]),
        shown,
      ),
    ),
    [fresh.key, unreadMine.key, noLastRead.key],
  );
});

test("同じ行を取り直したら、新しい Hit を使う。出した行の記録は、足すものが無ければ同じものを返す", () => {
  const judge = judger({ C1: "1700000006.000000" });
  const rows = triageRows([unreadMine], judge, NOTHING_SHOWN);
  const shown = rememberShown(NOTHING_SHOWN, rows);
  assert.equal(rememberShown(shown, rows), shown);
  assert.equal(rememberShown(NOTHING_SHOWN, []), NOTHING_SHOWN);

  const edited = { ...unreadMine, text: "編集された本文" };
  const [row] = triageRows([edited], judge, shown);
  assert.equal(row.hit.text, "編集された本文");
  // 出した行の記録そのものは書き換えない
  assert.equal(NOTHING_SHOWN.size, 0);
});

test("出した行の記録に足すのは、出している行だけ。既読の行は、記録に無ければ出さず、足しもしない", () => {
  const judge = judger({
    C1: "1700000006.000000",
    C4: "1700000010.000000",
  });
  const rows = triageRows(mine, judge, NOTHING_SHOWN);
  const shown = rememberShown(NOTHING_SHOWN, rows);
  assert.deepEqual(
    [...shown.keys()].sort(),
    [unreadMine.key, threadReply.key, noLastRead.key].sort(),
  );
});

// ---- 保存した値を読む ---------------------------------------------------------------

test("保存した既読位置・印：形の合うものだけ読む。壊れた値・形が違う値は捨てる", () => {
  assert.deepEqual(
    [
      ...parseLastReads({
        C1: { lastRead: "1.0", at: 5 },
        C2: { lastRead: null, at: 6 },
        C3: { lastRead: 3, at: 7 },
        C4: "文字",
        C5: { lastRead: "1.0" },
        C6: { lastRead: "1.0", at: "昨日" },
      }).keys(),
    ],
    ["C1", "C2"],
  );
  for (const broken of [null, undefined, 3, "x", []]) {
    assert.equal(parseLastReads(broken).size, 0);
    assert.deepEqual(parseMarks(broken), {});
  }
  assert.deepEqual(parseMarks({ a: 1, b: "x", c: null, d: 2 }), { a: 1, d: 2 });
});

test("保存した整理の結果：形の合う Hit だけ読み、全体の形が違えば捨てる", () => {
  const good = hit("C1", "1700000001.000000", { userId: "U1" });
  assert.deepEqual(
    parseTriageEntry({ at: 5, hits: [good, { key: "壊れた" }, null, 3] }),
    { at: 5, hits: [good] },
  );
  // 任意の項目の型が違う Hit は捨てる
  assert.deepEqual(
    parseTriageEntry({ at: 5, hits: [{ ...good, userId: 3 }] })?.hits,
    [],
  );
  for (const broken of [
    null,
    undefined,
    [],
    { hits: [] },
    { at: "昨日", hits: [] },
    { at: 5, hits: "なし" },
  ]) {
    assert.equal(parseTriageEntry(broken), undefined);
  }
});

test("保存した整理の結果：検索が切れたときの境目は、形が合えば読み、合わなければ境目だけ捨てる。切れていなければ持たない", () => {
  const good = hit("C1", "1700000001.000000");
  assert.deepEqual(
    parseTriageEntry({
      at: 5,
      hits: [good],
      cappedBefore: "1700000300.000000",
    }),
    { at: 5, hits: [good], cappedBefore: "1700000300.000000" },
  );
  // 形の合わない境目は使わない（結果は読む）
  for (const broken of ["昨日", "1700000300", 1700000300, null]) {
    assert.deepEqual(
      parseTriageEntry({ at: 5, hits: [good], cappedBefore: broken }),
      { at: 5, hits: [good] },
    );
  }
  // 境目が無い（切れていない・境目を足す前の保存）ものは、そのまま読める
  assert.deepEqual(parseTriageEntry({ at: 5, hits: [good] }), {
    at: 5,
    hits: [good],
  });

  // 画面に渡すのは、時刻を除いた結果だけ
  assert.deepEqual(mentionsOf({ at: 5, hits: [good] }), { hits: [good] });
  assert.deepEqual(
    mentionsOf({ at: 5, hits: [good], cappedBefore: "1700000300.000000" }),
    { hits: [good], cappedBefore: "1700000300.000000" },
  );
});

test("保存したお気に入りの結果：形が合い、いまのお気に入りの組み合わせで、期限内のときだけ使う", () => {
  const chunk: FavoriteChunk = {
    ids: ["C1"],
    hits: [toFavoriteHit(hit("C1", "1700000001.000000"))],
    capped: false,
  };
  const entry = parseFavoriteEntry({ at: NOW, key: "C1", chunks: [chunk] });
  assert.deepEqual(entry, { at: NOW, key: "C1", chunks: [chunk] });

  // 組み合わせ（key）が違うか、期限（60秒）を過ぎていれば使わない
  assert.deepEqual(freshFavoriteChunks(entry, "C1", 60_000, NOW + 59_999), [
    chunk,
  ]);
  assert.equal(
    freshFavoriteChunks(entry, "C1", 60_000, NOW + 60_000),
    undefined,
  );
  assert.equal(freshFavoriteChunks(entry, "C1,C2", 60_000, NOW), undefined);
  assert.equal(freshFavoriteChunks(undefined, "C1", 60_000, NOW), undefined);

  // 形が違うもの（1つでも壊れた塊があれば全体を捨てる）
  for (const broken of [
    null,
    { at: NOW, key: "C1" },
    { at: NOW, key: "C1", chunks: [{ ids: ["C1"], hits: [], capped: "はい" }] },
    { at: NOW, key: "C1", chunks: [{ ids: [1], hits: [], capped: false }] },
    {
      at: NOW,
      key: "C1",
      chunks: [{ ids: [], hits: [{ ts: "1.0" }], capped: false }],
    },
  ]) {
    assert.equal(parseFavoriteEntry(broken), undefined);
  }
});

test("保存した個別の確かめ：形の合うものだけ読み、10分を過ぎたものは捨てる", () => {
  const result: FavoriteUnread = { channelId: "C1", count: 2, truncated: true };
  const entries = parseChecks({
    "C1:1.0": { at: NOW, result },
    "C2:2.0": { at: NOW, result: null },
    "C3:3.0": { at: NOW, result: { channelId: "C3" } },
    "C4:4.0": { at: "昨日", result: null },
    "C5:5.0": 3,
  });
  assert.deepEqual(Object.keys(entries), ["C1:1.0", "C2:2.0"]);
  assert.deepEqual(parseChecks(null), {});

  const aged = {
    "C1:1.0": { at: NOW - 10 * 60_000, result },
    "C2:2.0": { at: NOW - 10 * 60_000 - 1, result: null },
  };
  assert.deepEqual(Object.keys(pruneChecks(aged, NOW)), ["C1:1.0"]);
});

// ---- 開いた会話（未読タグをすぐ消す） ------------------------------------------------------

// 会話の行を開いた時刻（ミリ秒）と、その ts
const OPEN_AT = 1_790_000_000_250;
const OPEN_TS = "1790000000.250000";
// 開く s 秒前・s 秒後の ts
const secBefore = (s: number) => `${1_790_000_000 - s}.000000`;
const secAfter = (s: number) => `${1_790_000_000 + s}.000000`;

test("時刻を Slack の ts の形にする（秒.マイクロ秒）。新しい時刻ほど ts も新しい", () => {
  assert.equal(tsOfTime(OPEN_AT), OPEN_TS);
  assert.equal(tsOfTime(1_790_000_000_000), "1790000000.000000");
  assert.equal(tsOfTime(1_790_000_000_001), "1790000000.001000");
  assert.equal(tsOfTime(1_790_000_000_999), "1790000000.999000");
});

test("会話を開いた時刻を記録する：開いた会話ごとに同じ ts を持ち、開き直したら新しい時刻になる。渡した記録は変えない", () => {
  const before: Opened = { C9: secBefore(500) };
  const opened = openConversations(before, ["C1", "D2"], OPEN_AT);
  assert.deepEqual(opened, { C9: secBefore(500), C1: OPEN_TS, D2: OPEN_TS });
  // 渡した記録は変わらない
  assert.deepEqual(before, { C9: secBefore(500) });

  // 開き直したら、新しい時刻にする
  const again = openConversations(opened, ["C1"], OPEN_AT + 60_000);
  assert.equal(again.C1, "1790000060.250000");
  assert.equal(again.D2, OPEN_TS);

  // 開いた会話が無ければ、同じ記録を返す
  assert.equal(openConversations(before, [], OPEN_AT), before);
});

test("開いた時刻を持つのは1日（既読位置の保存と同じ）。ちょうど1日はまだ残る", () => {
  const opened: Opened = {
    new: OPEN_TS,
    edge: tsOfTime(OPEN_AT - LAST_READ_KEEP_MS),
    old: tsOfTime(OPEN_AT - LAST_READ_KEEP_MS - 1),
  };
  assert.deepEqual(Object.keys(pruneOpened(opened, OPEN_AT)).sort(), [
    "edge",
    "new",
  ]);
});

test("保存した開いた時刻：会話 ID → ts（秒.マイクロ秒）の形が合うものだけ読む", () => {
  assert.deepEqual(
    parseOpened({
      C1: OPEN_TS,
      C2: 1790000000.25, // 数値
      C3: "あした", // ts の形でない
      C4: "1790000000", // 小数部が無い
      C5: null,
    }),
    { C1: OPEN_TS },
  );
  for (const raw of [undefined, null, "x", 3, ["C1"]]) {
    assert.deepEqual(parseOpened(raw), {}, String(raw));
  }
});

test("未読タグを数える既読位置：開いた会話は、開いた時刻までを既読として扱う。ほかの会話と、Slack の値の新しい会話は変えない", () => {
  const fetchedBefore = OPEN_AT - 120_000;
  const entries = new Map<string, CachedLastRead>([
    ["C1", { lastRead: secBefore(100), at: fetchedBefore }],
    ["C2", { lastRead: secBefore(100), at: fetchedBefore }],
    // Slack の既読位置のほうが開いた時刻より新しい（開いたあとに読み進めた）：Slack の値のまま
    ["C3", { lastRead: secAfter(5), at: fetchedBefore }],
  ]);
  const opened: Opened = { C1: OPEN_TS, C3: OPEN_TS };
  const map = lastReadsForTags(entries, opened);
  assert.equal(map.get("C1"), OPEN_TS);
  assert.equal(map.get("C2"), secBefore(100));
  assert.equal(map.get("C3"), secAfter(5));
  // 開いたことは、もとの表を変えない
  assert.equal(entries.get("C1")?.lastRead, secBefore(100));
  // 何も開いていなければ、lastReadMap と同じ
  assert.deepEqual(lastReadsForTags(entries, {}), lastReadMap(entries));
});

test("既読位置が分からない会話（取れていない・参加していない）は、開いても数え始めない", () => {
  const entries = new Map<string, CachedLastRead>([
    ["C1", { lastRead: null, at: OPEN_AT - 1_000 }],
  ]);
  const map = lastReadsForTags(entries, { C1: OPEN_TS, C2: OPEN_TS });
  assert.equal(map.size, 0);
});

test("開いたあとに Slack から取り直した既読位置は、Slack の値で数え直す。取り終えたのが開いた時刻の30秒以内なら、開く前に始めた問い合わせかもしれないので、取り直しと見なさない", () => {
  const opened: Opened = { C1: OPEN_TS };
  const at = (laterMs: number): Map<string, CachedLastRead> =>
    new Map([["C1", { lastRead: secBefore(100), at: OPEN_AT + laterMs }]]);
  const limit = LAST_READ_TIMEOUT_MS;
  // 開く前に始めた問い合わせが、開いた直後に終わった：Slack の値（開く前の状態）で上書きしない
  assert.equal(lastReadsForTags(at(1_000), opened).get("C1"), OPEN_TS);
  assert.equal(lastReadsForTags(at(limit), opened).get("C1"), OPEN_TS);
  // それより後に取り終えたものは、開いたあとに取り直した値：Slack の値に戻す
  assert.equal(
    lastReadsForTags(at(limit + 1), opened).get("C1"),
    secBefore(100),
  );
  assert.equal(
    lastReadsForTags(at(5 * 60_000), opened).get("C1"),
    secBefore(100),
  );
  // 開く前に取った値は、開いたことを反映する
  assert.equal(lastReadsForTags(at(-60_000), opened).get("C1"), OPEN_TS);

  // 開き直したら、また開いた時刻までを既読として扱う
  const reopened = openConversations(opened, ["C1"], OPEN_AT + 10 * 60_000);
  assert.equal(
    lastReadsForTags(at(5 * 60_000), reopened).get("C1"),
    reopened.C1,
  );
});

test("既読位置の取得の結果：問い合わせを始めたあとに忘れた会話（行を開いた）は保存しない。始める前に忘れたもの・忘れていないものは保存する", () => {
  const save = new Map<string, CachedLastRead>([
    ["C1", { lastRead: secBefore(100), at: OPEN_AT }],
    ["C2", { lastRead: secBefore(100), at: OPEN_AT }],
    ["C3", { lastRead: secBefore(100), at: OPEN_AT }],
    ["C4", { lastRead: null, at: OPEN_AT }],
  ]);
  const requestedAt = OPEN_AT - 5_000;
  const forgotten: Record<string, number> = {
    // 問い合わせを始めたあとに忘れた
    C1: requestedAt + 1_000,
    // 始めたのと同じ時刻（どちらが先か分からない）：保存しない側に倒す
    C2: requestedAt,
    // 始める前に忘れた：開いたあとに取った値なので保存する
    C3: requestedAt - 1,
  };
  const keep = keepFetchedLastReads(save, (id) => forgotten[id], requestedAt);
  assert.deepEqual([...keep.keys()], ["C3", "C4"]);
  // 渡した表は変えない
  assert.equal(save.size, 4);
});

test("お気に入りのまとめ検索の結果がある会話：結果が来るまでの会話と、お気に入りでなくなった会話は含めない", () => {
  const chunks = [
    { ids: ["C1", "C2"] },
    // 未読が無かった会話（C3）も、結果はある
    { ids: ["C3", "C9"] },
  ];
  // C9 は、結果が出たあとにお気に入りから外した。C4 は、お気に入りに足したばかりで、結果が無い
  const favorites = new Set(["C1", "C2", "C3", "C4"]);
  assert.deepEqual([...favoritesWithResult(chunks, favorites)].sort(), [
    "C1",
    "C2",
    "C3",
  ]);
  // 結果がまだ無ければ、どのお気に入りも含まない
  assert.equal(favoritesWithResult([], favorites).size, 0);
});
