import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import {
  applyChecks,
  cappedBeforeOf,
  favoritesWithResult,
  handledKeys,
  judgeReadState,
  lastReadsForTags,
  mineCompleteFrom,
  openConversations,
  summarizeFavorites,
  toFavoriteHit,
  toggleHandled,
  unknownCheckKey,
  type CachedLastRead,
  type FavoriteChunk,
  type FavoriteUnread,
  type Opened,
} from "./triage.ts";
import {
  conversationsOfRow,
  formatTag,
  unreadTags,
  type UnreadTag,
} from "./unread-tags.ts";

const SELF = "U0000000013";
const NOW = 1_759_560_000_000;

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

// 自分宛てが全期間そろっているものとして扱う境目（下限にならない）
const ALL_COMPLETE = "0";

// 自分宛てのメッセージ（過去7日）と既読位置から、行の id ごとの件数を出す。お気に入りは無い
const tagsOf = (
  mine: Hit[],
  lastReads: Record<string, string>,
  rest: {
    favorites?: FavoriteUnread[];
    // お気に入りのまとめ検索の結果がある会話
    favoriteResultIds?: string[];
    // 自分宛ての結果が揃っている期間の始まり。省略は全期間そろっている
    mineFrom?: string;
  } = {},
) =>
  unreadTags({
    mine,
    lastReads: new Map(Object.entries(lastReads)),
    favorites: rest.favorites ?? [],
    favoriteResultIds: new Set(rest.favoriteResultIds ?? []),
    mineFrom: rest.mineFrom ?? ALL_COMPLETE,
    selfId: SELF,
  });

test("既読位置より新しい最上位の投稿を数える。スレッド返信と自分の投稿は数えない", () => {
  const tags = tagsOf(
    [
      hit("C1", "1700000009.000000"),
      hit("C1", "1700000008.000000"),
      // スレッド返信
      hit("C1", "1700000010.000000", { threadTs: "1700000000.000000" }),
      // 自分の投稿
      hit("C1", "1700000011.000000", { userId: SELF }),
      // 既読位置と同じか古い
      hit("C1", "1700000006.000000"),
      hit("C1", "1700000005.000000"),
    ],
    { C1: "1700000006.000000" },
  );
  assert.deepEqual([...tags], [["C1", { count: 2, atLeast: false }]]);
});

test("新しいのがスレッド返信だけの会話は、タグを持たない（0件）", () => {
  const tags = tagsOf(
    [
      hit("C1", "1700000009.000000", { threadTs: "1700000000.000000" }),
      hit("C1", "1700000010.000000", { threadTs: "1700000001.000000" }),
      hit("C2", "1700000009.000000"),
    ],
    { C1: "1700000005.000000", C2: "1700000005.000000" },
  );
  assert.equal(tags.has("C1"), false);
  assert.deepEqual(tags.get("C2"), { count: 1, atLeast: false });
});

test("対応済みの印があっても数える。タグは Slack の既読位置だけで決まる", () => {
  const read = hit("C1", "1700000009.000000");
  // 印を付けると、整理の判定は「対応済み」になる
  const marks = toggleHandled({}, read.key, NOW);
  assert.equal(
    judgeReadState(read, "1700000006.000000", handledKeys(marks, NOW)),
    "handled",
  );
  // それでもタグは数える（印を受け取らない）
  assert.deepEqual(tagsOf([read], { C1: "1700000006.000000" }).get("C1"), {
    count: 1,
    atLeast: false,
  });
  // Slack で読めば（既読位置が進めば）消える
  assert.equal(tagsOf([read], { C1: "1700000009.000000" }).has("C1"), false);
});

test("既読位置が分からない会話は、未読か分からないので数えない", () => {
  assert.equal(tagsOf([hit("C1", "1700000009.000000")], {}).size, 0);
});

test("DM の件数は、会話の行でなく、相手の人の行の id に付く。グループDM は会話の行に付く", () => {
  const tags = tagsOf(
    [
      hit("D1", "1700000009.000000", {
        channelKind: "im",
        channelName: "U2",
        mentionsSelf: false,
      }),
      hit("D1", "1700000008.000000", {
        channelKind: "im",
        channelName: "U2",
        mentionsSelf: false,
      }),
      // 相手が分からない DM は、行を決められない
      hit("D3", "1700000009.000000", {
        channelKind: "im",
        mentionsSelf: false,
      }),
      hit("G4", "1700000009.000000", {
        channelKind: "mpim",
        mentionsSelf: false,
      }),
    ],
    {
      D1: "1700000005.000000",
      D3: "1700000005.000000",
      G4: "1700000005.000000",
    },
  );
  assert.deepEqual(
    [...tags].sort(),
    [
      ["G4", { count: 1, atLeast: false }],
      ["U2", { count: 2, atLeast: false }],
    ].sort(),
  );
  // DM の会話 ID（D1）には付かない
  assert.equal(tags.has("D1"), false);
});

test("お気に入りの会話で、自分宛ての未読が1件だけなら、タグは1（二重に数えない）。まとめ検索の結果が来る前も、来たあとも", () => {
  // 自分がメンションされた未読の最上位の投稿が1件。お気に入りのまとめ検索にも、同じ投稿が1件入っている
  const mention = hit("C1", "1700000009.000000");
  const favorite: FavoriteUnread = {
    channelId: "C1",
    count: 1,
    latestTs: "1700000009.000000",
    truncated: false,
  };
  // 結果が来たあと：お気に入りの件数（1）だけを使う。自分宛ての件数を足して 2 にしない
  const arrived = tagsOf(
    [mention],
    { C1: "1700000006.000000" },
    { favorites: [favorite], favoriteResultIds: ["C1"] },
  );
  assert.deepEqual([...arrived], [["C1", { count: 1, atLeast: false }]]);
  // 結果が来る前（取得中・停止・失敗）：自分宛ての件数（1）で出す
  const waiting = tagsOf([mention], { C1: "1700000006.000000" });
  assert.deepEqual([...waiting], [["C1", { count: 1, atLeast: false }]]);
});

test("お気に入りの会話は、まとめ検索の結果が来たら、その件数だけを使う。自分宛ての件数は足さず、結果で未読が無かった会話は自分宛ての件数で補わない", () => {
  const mentions = [
    hit("C1", "1700000009.000000"),
    hit("C1", "1700000008.000000"),
    hit("C2", "1700000009.000000"),
  ];
  const lastReads = {
    C1: "1700000006.000000",
    C2: "1700000006.000000",
    C3: "1700000006.000000",
  };
  const tags = tagsOf(mentions, lastReads, {
    // C1 のお気に入りの件数は5（メンション以外の投稿も入っている）。
    // C2 も結果はあるが、未読が無かった（件数の一覧に出ない）
    favorites: [
      {
        channelId: "C1",
        count: 5,
        latestTs: "1700000009.000000",
        truncated: false,
      },
      // お気に入りでない会話の件数は使わない
      { channelId: "C3", count: 9, truncated: false },
    ],
    favoriteResultIds: ["C1", "C2"],
  });
  assert.deepEqual([...tags], [["C1", { count: 5, atLeast: false }]]);
  // お気に入りでない会話は、自分宛ての件数を使う
  assert.deepEqual(tagsOf(mentions, lastReads).get("C2"), {
    count: 1,
    atLeast: false,
  });
});

test("お気に入りの会話は、まとめ検索の結果が無い間（取得中・停止・失敗）は、自分宛ての件数で出す。結果が来たら、お気に入りの件数に置き換わる", () => {
  const mentions = [
    hit("C1", "1700000009.000000"),
    hit("C1", "1700000008.000000"),
    hit("C2", "1700000009.000000"),
    hit("D3", "1700000009.000000", {
      channelKind: "im",
      channelName: "U3",
      mentionsSelf: false,
    }),
  ];
  const lastReads = {
    C1: "1700000006.000000",
    C2: "1700000006.000000",
    D3: "1700000006.000000",
  };
  // 結果が無い（お気に入りは C1・C2 だが、検索が終わっていない）：ほかの会話と同じ数え方
  assert.deepEqual(Object.fromEntries(tagsOf(mentions, lastReads)), {
    C1: { count: 2, atLeast: false },
    C2: { count: 1, atLeast: false },
    U3: { count: 1, atLeast: false },
  });
  // C1 の結果が来た（メンション以外の投稿も入った5件）：C1 だけが置き換わる。7（5+2）にはならない
  assert.deepEqual(
    Object.fromEntries(
      tagsOf(mentions, lastReads, {
        favorites: [
          {
            channelId: "C1",
            count: 5,
            latestTs: "1700000009.000000",
            truncated: false,
          },
        ],
        favoriteResultIds: ["C1"],
      }),
    ),
    {
      C1: { count: 5, atLeast: false },
      C2: { count: 1, atLeast: false },
      U3: { count: 1, atLeast: false },
    },
  );
});

test("お気に入りの件数が下限のときは atLeast になり、「3+」の形で出る。件数不明（0件）はタグを持たない", () => {
  const tags = tagsOf(
    [],
    {},
    {
      favorites: [
        {
          channelId: "C1",
          count: 3,
          latestTs: "1700000009.000000",
          truncated: true,
        },
        { channelId: "C2", count: 0, truncated: true },
      ],
      favoriteResultIds: ["C1", "C2"],
    },
  );
  assert.deepEqual(tags.get("C1"), { count: 3, atLeast: true });
  assert.equal(tags.has("C2"), false);

  assert.equal(formatTag({ count: 3, atLeast: true }), "3+");
  assert.equal(formatTag({ count: 12, atLeast: false }), "12");
});

test("お気に入りの会話と DM の人の行が同じ一覧にあっても、それぞれの数え方で出る", () => {
  const tags = tagsOf(
    [
      hit("C1", "1700000009.000000"),
      hit("D2", "1700000009.000000", {
        channelKind: "im",
        channelName: "U2",
        mentionsSelf: false,
      }),
      hit("C9", "1700000009.000000"),
    ],
    {
      C1: "1700000006.000000",
      D2: "1700000006.000000",
      C9: "1700000006.000000",
    },
    {
      favorites: [
        {
          channelId: "C1",
          count: 4,
          latestTs: "1700000009.000000",
          truncated: false,
        },
      ],
      favoriteResultIds: ["C1"],
    },
  );
  assert.deepEqual(Object.fromEntries(tags), {
    C1: { count: 4, atLeast: false },
    U2: { count: 1, atLeast: false },
    C9: { count: 1, atLeast: false },
  });
});

// ---- 会話の行を開いたら、その行の未読タグをすぐ消す ---------------------------------------------

// 会話の行を開いた時刻（ミリ秒）。開く s 秒前・s 秒後の ts を作る
const OPEN_AT = 1_790_000_000_250;
const secBefore = (s: number) => `${1_790_000_000 - s}.000000`;
const secAfter = (s: number) => `${1_790_000_000 + s}.000000`;

const dm = (channelId: string, partner: string, ts: string): Hit =>
  hit(channelId, ts, {
    channelKind: "im",
    channelName: partner,
    mentionsSelf: false,
  });

// 開く前の一覧：チャンネル C1 に未読2件、相手 U2 との DM（D1）に未読1件、チャンネル C9 に未読1件、
// お気に入りの F1 に未読2件。既読位置はどれも開く100秒前
const MINE: Hit[] = [
  hit("C1", secBefore(50)),
  hit("C1", secBefore(40)),
  dm("D1", "U2", secBefore(30)),
  hit("C9", secBefore(20)),
];
const F1_HITS = [secBefore(60), secBefore(55)];
const favoriteChunks = (extra: string[] = []): FavoriteChunk[] => [
  {
    ids: ["F1"],
    hits: [...F1_HITS, ...extra].map((ts) => toFavoriteHit(hit("F1", ts))),
    capped: false,
  },
];
// 既読位置を取った時刻（at）つきの表。overrides は Slack が返した既読位置
const cached = (
  at: number,
  overrides: Record<string, string> = {},
): Map<string, CachedLastRead> =>
  new Map(
    ["C1", "D1", "C9", "F1"].map((id) => [
      id,
      { lastRead: overrides[id] ?? secBefore(100), at },
    ]),
  );
const FETCHED_BEFORE_OPEN = OPEN_AT - 120_000;

// 画面（use-triage.ts）と同じ組み立てで、行の id ごとのタグを出す：
// 既読位置に開いた会話を反映し、お気に入りの未読を数えて、タグを作る
function tagsWith(params: {
  lastReads: Map<string, CachedLastRead>;
  opened: Opened;
  mine?: Hit[];
  chunks?: FavoriteChunk[];
}): Map<string, UnreadTag> {
  const effective = lastReadsForTags(params.lastReads, params.opened);
  const chunks = params.chunks ?? favoriteChunks();
  const favorites = summarizeFavorites({
    chunks,
    favoriteIds: ["F1"],
    lastReads: effective,
    selfId: SELF,
    horizonTs: secBefore(600),
  });
  return unreadTags({
    mine: params.mine ?? MINE,
    lastReads: effective,
    favorites,
    favoriteResultIds: favoritesWithResult(chunks, new Set(["F1"])),
    mineFrom: ALL_COMPLETE,
    selfId: SELF,
  });
}
// タグの文字（行の id → 「2」「3+」）
const labels = (tags: Map<string, UnreadTag>) =>
  Object.fromEntries([...tags].map(([id, tag]) => [id, formatTag(tag)]));

// 行を開く：その行の会話の開いた時刻を記録する（画面の markConversationOpened と同じ）
const openRow = (
  row: { id: string; isPerson: boolean },
  opened: Opened = {},
  mine: Hit[] = MINE,
) => openConversations(opened, conversationsOfRow(row, mine), OPEN_AT);

test("会話の行を開くと、その行の未読タグがすぐ消える。人の行は、その人との DM のタグが消える。開いていない行は変わらない", () => {
  const lastReads = cached(FETCHED_BEFORE_OPEN);
  assert.deepEqual(labels(tagsWith({ lastReads, opened: {} })), {
    C1: "2",
    U2: "1",
    C9: "1",
    F1: "2",
  });

  // チャンネルの行
  const channel = openRow({ id: "C1", isPerson: false });
  assert.deepEqual(labels(tagsWith({ lastReads, opened: channel })), {
    U2: "1",
    C9: "1",
    F1: "2",
  });
  // 人の行（その人との DM の件数が付いている行）
  const person = openRow({ id: "U2", isPerson: true });
  assert.deepEqual(labels(tagsWith({ lastReads, opened: person })), {
    C1: "2",
    C9: "1",
    F1: "2",
  });
  // お気に入りの会話（お気に入りのまとめ検索の件数）
  const favorite = openRow({ id: "F1", isPerson: false });
  assert.deepEqual(labels(tagsWith({ lastReads, opened: favorite })), {
    C1: "2",
    U2: "1",
    C9: "1",
  });
  // 続けて開いた分も消える
  const all = openRow({ id: "F1", isPerson: false }, channel);
  assert.deepEqual(labels(tagsWith({ lastReads, opened: all })), {
    U2: "1",
    C9: "1",
  });
});

test("開いたあとに届いた新しい投稿は、取り直しを待たずに数える", () => {
  const lastReads = cached(FETCHED_BEFORE_OPEN);
  const opened = openRow(
    { id: "F1", isPerson: false },
    openRow(
      { id: "U2", isPerson: true },
      openRow({ id: "C1", isPerson: false }),
    ),
  );
  const mine = [
    ...MINE,
    hit("C1", secAfter(5)),
    dm("D1", "U2", secAfter(6)),
    dm("D1", "U2", secAfter(7)),
  ];
  const tags = tagsWith({
    lastReads,
    opened,
    mine,
    chunks: favoriteChunks([secAfter(8)]),
  });
  assert.deepEqual(labels(tags), { C1: "1", U2: "2", C9: "1", F1: "1" });
});

test("既読位置を Slack から取り直すと、Slack の値で数え直す：Slack で読んでいなければタグは戻り、読んでいれば戻らない", () => {
  const opened = openRow(
    { id: "F1", isPerson: false },
    openRow(
      { id: "U2", isPerson: true },
      openRow({ id: "C1", isPerson: false }),
    ),
  );
  const refetchedAt = OPEN_AT + 60_000;
  // 開いたあとに取り直したが、Slack ではまだ読んでいない（既読位置が進んでいない）：タグが戻る
  assert.deepEqual(
    labels(tagsWith({ lastReads: cached(refetchedAt), opened })),
    { C1: "2", U2: "1", C9: "1", F1: "2" },
  );
  // 開いた会話を Slack で読んだ（既読位置が進んだ）：戻らない。読んでいない会話（U2 の DM）だけが戻る
  assert.deepEqual(
    labels(
      tagsWith({
        lastReads: cached(refetchedAt, {
          C1: secBefore(10),
          F1: secBefore(10),
        }),
        opened,
      }),
    ),
    { U2: "1", C9: "1" },
  );
});

test("開く前に始めた既読位置の取り直しが、開いた直後に終わっても、開いた会話のタグは戻らない", () => {
  const opened = openRow({ id: "C1", isPerson: false });
  // 開いた10秒後に取り終えた（問い合わせは開く前に始まったかもしれない）。Slack の値はまだ古い
  const lastReads = cached(OPEN_AT + 10_000);
  assert.deepEqual(labels(tagsWith({ lastReads, opened })), {
    U2: "1",
    C9: "1",
    F1: "2",
  });
});

test("既読位置が分からない会話は、開いてもタグを数え始めない", () => {
  // C5 は既読位置を取れていない（保存に無い）。ほかの会話（F1）のタグは、そのまま出る
  const mine = [hit("C5", secBefore(10))];
  const lastReads = cached(FETCHED_BEFORE_OPEN);
  assert.deepEqual(labels(tagsWith({ lastReads, opened: {}, mine })), {
    F1: "2",
  });
  const opened = openRow({ id: "C5", isPerson: false }, {}, mine);
  assert.deepEqual(opened, { C5: "1790000000.250000" });
  assert.deepEqual(labels(tagsWith({ lastReads, opened, mine })), { F1: "2" });
});

test("開く行の会話：人の行はその人との DM の会話 ID、それ以外の行は会話そのもの", () => {
  const mine = [
    ...MINE,
    // 同じ人との、別の DM の会話 ID があっても（相手の人で引くので）両方
    dm("D7", "U2", secBefore(10)),
    dm("D7", "U2", secBefore(9)),
    dm("D3", "U3", secBefore(10)),
    // 相手が分からない DM は、どの人の行にも付かない
    hit("D4", secBefore(10), { channelKind: "im", mentionsSelf: false }),
    hit("G4", secBefore(10), { channelKind: "mpim", mentionsSelf: false }),
  ];
  // 人の行：DM の相手（channel.name に入っているユーザー ID）が、その人の ID の DM だけ。重複は除く
  assert.deepEqual(conversationsOfRow({ id: "U2", isPerson: true }, mine), [
    "D1",
    "D7",
  ]);
  assert.deepEqual(conversationsOfRow({ id: "U3", isPerson: true }, mine), [
    "D3",
  ]);
  // その人との DM が自分宛ての中に無ければ、タグも付いていないので空
  assert.deepEqual(conversationsOfRow({ id: "U9", isPerson: true }, mine), []);
  // チャンネルの投稿の会話 ID は、人の行には使わない（人の ID と同じ ID のチャンネルは無いが、DM 以外は引かない）
  assert.deepEqual(conversationsOfRow({ id: "C1", isPerson: true }, mine), []);
  // それ以外の行（チャンネル・非公開・グループDM・お気に入り）は、会話そのもの
  for (const id of ["C1", "G4", "F1", "C404"]) {
    assert.deepEqual(conversationsOfRow({ id, isPerson: false }, mine), [id]);
  }
});

test("人の行の DM の対応は、タグを付けるときと同じ：タグが付いている人の行は、必ず開く会話が見つかる", () => {
  const tags = tagsWith({
    lastReads: cached(FETCHED_BEFORE_OPEN),
    opened: {},
  });
  for (const id of tags.keys()) {
    // U2 は人の行
    if (id !== "U2") continue;
    assert.deepEqual(conversationsOfRow({ id, isPerson: true }, MINE), ["D1"]);
  }
  assert.equal(tags.has("U2"), true);
});

// ---- 数えきれていない件数は下限（「3+」）にする ------------------------------------------------

// 自分宛ての結果が揃っている期間の始まりが 1700000000 のとき
const FROM = "1700000000.000000";

test("自分宛ての件数は、既読位置が結果の揃っている期間の始まりより前なら下限（「2+」）。期間の中なら下限にならない。ちょうど始まりでも下限にならない", () => {
  const mine = [
    // 既読位置が期間より前の DM（相手 U2）
    dm("D1", "U2", "1700000009.000000"),
    dm("D1", "U2", "1700000008.000000"),
    // 既読位置が期間の中の DM（相手 U3）
    dm("D3", "U3", "1700000009.000000"),
    // 既読位置がちょうど期間の始まりのチャンネル
    hit("C4", "1700000009.000000"),
    // 既読位置が期間より前のグループDM とチャンネル
    hit("G5", "1700000009.000000", { channelKind: "mpim" }),
    hit("C6", "1700000009.000000"),
  ];
  const tags = tagsOf(
    mine,
    {
      D1: "1699999000.000000",
      D3: "1700000005.000000",
      C4: FROM,
      G5: "1699999999.999999",
      C6: "1699999000.000000",
    },
    { mineFrom: FROM },
  );
  assert.deepEqual(labels(tags), {
    U2: "2+",
    U3: "1",
    C4: "1",
    G5: "1+",
    C6: "1+",
  });
});

test("1つの行に複数の会話の件数が入るとき、1つでも下限なら行の件数は下限。入る順に関わらない", () => {
  // 同じ相手 U2 の DM が2つの会話にまたがる：D1 は既読位置が期間の中、D2 は期間より前
  const inside = dm("D1", "U2", "1700000009.000000");
  const before = dm("D2", "U2", "1700000009.000000");
  const lastReads = { D1: "1700000005.000000", D2: "1699999000.000000" };
  for (const mine of [
    [inside, before],
    [before, inside],
  ]) {
    assert.deepEqual(tagsOf(mine, lastReads, { mineFrom: FROM }).get("U2"), {
      count: 2,
      atLeast: true,
    });
  }
});

test("お気に入りの会話は、まとめ検索の結果が来たら、自分宛ての期間に左右されない。結果が来る前は、自分宛ての件数なので期間で下限になる", () => {
  const mine = [hit("C1", "1700000009.000000")];
  // 既読位置は自分宛ての期間より前。お気に入りの件数は、お気に入りの検索で数えた正確な1件
  const lastReads = { C1: "1699999000.000000" };
  const favorites: FavoriteUnread[] = [
    {
      channelId: "C1",
      count: 1,
      latestTs: "1700000009.000000",
      truncated: false,
    },
  ];
  assert.deepEqual(
    tagsOf(mine, lastReads, {
      favorites,
      favoriteResultIds: ["C1"],
      mineFrom: FROM,
    }).get("C1"),
    { count: 1, atLeast: false },
  );
  // 結果が来る前は、自分宛ての件数（期間より前の既読位置なので下限）
  assert.deepEqual(tagsOf(mine, lastReads, { mineFrom: FROM }).get("C1"), {
    count: 1,
    atLeast: true,
  });
});

test("自分宛ての検索が上限で切れたら、取れた一番古い投稿より前に既読位置がある会話の件数は下限になる。切れていなければ、期間の中の既読位置は下限にならない", () => {
  // メンションの検索は上限で切れ、取れた一番古い投稿は 1700000300。to: の検索は切れていない
  const mention = [
    hit("C1", "1700000900.000000"),
    hit("C2", "1700000800.000000"),
    hit("C1", "1700000300.000000"),
  ];
  const to = [dm("D3", "U3", "1700000700.000000")];
  // C1 は取れた範囲の外（古い側）に既読位置がある。C2 は取れた範囲の中。D3 は切れていない to: の結果
  const lastReads = {
    C1: "1700000200.000000",
    C2: "1700000400.000000",
    D3: "1700000200.000000",
  };
  const since = FROM;
  const tagsFor = (searches: { hits: Hit[]; capped: boolean }[]) =>
    labels(
      tagsOf([...mention, ...to], lastReads, {
        mineFrom: mineCompleteFrom(since, cappedBeforeOf(searches)),
      }),
    );

  // 切れた：境目は 1700000300。それより前に既読位置がある C1 と、同じ結果に入る D3 も下限
  assert.deepEqual(
    tagsFor([
      { hits: mention, capped: true },
      { hits: to, capped: false },
    ]),
    { C1: "2+", C2: "1", U3: "1+" },
  );
  // 切れていない：既読位置はどれも期間の中なので、下限にならない
  assert.deepEqual(
    tagsFor([
      { hits: mention, capped: false },
      { hits: to, capped: false },
    ]),
    { C1: "2", C2: "1", U3: "1" },
  );
});

// ---- 件数不明のお気に入りは、結果が無いのと同じに、自分宛ての件数を下限で出す ----------------------------

// まとめ検索が上限で切れ、その会話の投稿が取れた範囲より古い：未読があるかも件数も分からない
const UNKNOWN: FavoriteUnread = { channelId: "C1", count: 0, truncated: true };

test("お気に入りが件数不明（件数0・下限）でも、自分宛ての未読があれば、その件数を下限（「1+」）で出す。結果が無い間は、下限を付けない", () => {
  const mine = [hit("C1", "1700000009.000000")];
  const lastReads = { C1: "1700000006.000000" };

  // 結果はあるが件数不明：結果が無いのと同じに、自分宛ての件数で出す。お気に入りの本当の件数はこれ以上なので、下限
  // （自分宛ての期間は全期間そろっているので、下限になるのは件数不明のため）
  const unknown = tagsOf(mine, lastReads, {
    favorites: [UNKNOWN],
    favoriteResultIds: ["C1"],
  });
  assert.deepEqual([...unknown], [["C1", { count: 1, atLeast: true }]]);
  assert.deepEqual(labels(unknown), { C1: "1+" });

  // まとめ検索の結果が無い間（取得中・停止・失敗）は、これまでどおり下限を付けない
  const waiting = tagsOf(mine, lastReads);
  assert.deepEqual(labels(waiting), { C1: "1" });

  // 件数不明の会話の自分宛てを、ほかの会話の数え方と混ぜない
  const mixed = tagsOf(
    [...mine, hit("C2", "1700000009.000000")],
    {
      ...lastReads,
      C2: "1700000006.000000",
    },
    { favorites: [UNKNOWN], favoriteResultIds: ["C1"] },
  );
  assert.deepEqual(labels(mixed), { C1: "1+", C2: "1" });
});

test("お気に入りが件数不明で、自分宛ての未読が0件なら、タグは出ない。数えない投稿（既読位置以前・スレッド返信・自分の投稿）だけでも同じ", () => {
  const lastReads = { C1: "1700000006.000000" };
  const sizeOf = (mine: Hit[]) =>
    tagsOf(mine, lastReads, {
      favorites: [UNKNOWN],
      favoriteResultIds: ["C1"],
    }).size;

  assert.equal(sizeOf([]), 0);
  assert.equal(
    sizeOf([
      hit("C1", "1700000005.000000"),
      hit("C1", "1700000009.000000", { threadTs: "1700000000.000000" }),
      hit("C1", "1700000010.000000", { userId: SELF }),
    ]),
    0,
  );
});

test("件数不明のお気に入りに、件数の分かる結果（個別の確かめを含む）が来たら、お気に入りの件数に置き換わる。自分宛ての件数は足さない", () => {
  const lastRead = "1700000006.000000";
  const lastReads = new Map([["F1", lastRead]]);
  // まとめ検索が上限で切れ、F1 の投稿は取れた範囲より古い（件数不明）
  const chunks: FavoriteChunk[] = [{ ids: ["F1"], hits: [], capped: true }];
  const summary = summarizeFavorites({
    chunks,
    favoriteIds: ["F1"],
    lastReads,
    selfId: SELF,
    horizonTs: "1699990000.000000",
  });
  assert.deepEqual(summary, [{ channelId: "F1", count: 0, truncated: true }]);

  // F1 には、自分宛ての未読が1件ある
  const mine = [hit("F1", "1700000009.000000")];
  // 画面と同じ組み立て：個別の確かめの結果をお気に入りの未読に反映してから、タグを数える
  const labelsWith = (checks: Record<string, FavoriteUnread | null>) =>
    labels(
      unreadTags({
        mine,
        lastReads,
        favorites: applyChecks(summary, checks, lastReads),
        favoriteResultIds: favoritesWithResult(chunks, new Set(["F1"])),
        mineFrom: ALL_COMPLETE,
        selfId: SELF,
      }),
    );
  const key = unknownCheckKey("F1", lastRead);
  const checked = (count: number, truncated: boolean): FavoriteUnread => ({
    channelId: "F1",
    count,
    latestTs: "1700000009.000000",
    truncated,
  });

  // 確かめる前：自分宛ての1件を下限で出す
  assert.deepEqual(labelsWith({}), { F1: "1+" });
  // 確かめて、件数が分かった（4件）：お気に入りの件数だけ。自分宛ての1件を足して 5 にしない
  assert.deepEqual(labelsWith({ [key]: checked(4, false) }), { F1: "4" });
  // 確かめても上限で切れていた：お気に入りの件数が下限のまま置き換わる
  assert.deepEqual(labelsWith({ [key]: checked(4, true) }), { F1: "4+" });
  // 確かめて、未読が無かった：自分宛ての件数で補わず、タグは出ない
  assert.deepEqual(labelsWith({ [key]: null }), {});
});
