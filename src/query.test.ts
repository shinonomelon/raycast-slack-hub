import { test } from "node:test";
import assert from "node:assert/strict";
import { toFilterSources, toItems } from "./items.ts";
import {
  applyCandidate,
  candidatesFor,
  completingToken,
  orderSources,
  parseQuery,
  resolveQuery,
  type FilterSource,
  type FilterToken,
} from "./query.ts";
import type { Conversation, Person, Prefs } from "./types.ts";

const SELF = "U0000000013";
// 自分のハンドル（whoami の user と Previous Handles）。グループDMの名前から自分を除く
const SELF_HANDLES = ["example_user", "example_old"];

// Open Channel と同じく、照合語には名前・辞書で置き換えた名前・別名が入る
const sources: FilterSource[] = [
  {
    id: "C100",
    kind: "channel",
    title: "op_自動取得課_オペレーター",
    keywords: ["op_自動取得課_オペレーター", "op_auto課_オペレーター"],
    token: "#op_自動取得課_オペレーター",
  },
  {
    id: "C200",
    kind: "channel",
    title: "op_remote_op_自動取得",
    keywords: ["op_remote_op_自動取得", "op_remote_op_auto"],
    token: "#op_remote_op_自動取得",
  },
  {
    id: "C300",
    kind: "private",
    title: "times_example_user",
    keywords: ["times_example_user", "分報"],
    token: "#times_example_user",
  },
  {
    id: "G400",
    kind: "group",
    title: "山田, 佐藤",
    keywords: ["山田, 佐藤", "jones_f", "sato_y"],
    token: "#mpdm-jones_f--sato_y-1",
  },
  {
    id: "U500",
    kind: "person",
    title: "山田 三郎",
    keywords: ["山田 三郎", "jones_f"],
    token: "@jones_f",
  },
  {
    id: "U600",
    kind: "person",
    title: "佐藤 次郎",
    keywords: ["佐藤 次郎", "sato_y", "佐藤さん"],
    token: "@sato_y",
  },
];

const filterAt = (text: string): FilterToken => {
  const token = completingToken(parseQuery(text));
  assert.ok(token, `入力中の絞り込みがあるはず: ${text}`);
  return token;
};

test("語に分ける。引用符の句、全角の空白とコロン、否定を扱う", () => {
  const { tokens } = parseQuery(
    '"請求 書" in：op_auto　-from:me after:2026-09-01',
  );
  assert.deepEqual(
    tokens.map((t) =>
      t.type === "filter"
        ? `${t.negated ? "-" : ""}${t.modifier}=${t.value}`
        : `${t.type}:${t.raw}`,
    ),
    ['text:"請求 書"', "in=op_auto", "-from=me", "other:after:2026-09-01"],
  );
});

test("末尾が絞り込みで空白を打っていなければ入力中とみなす", () => {
  assert.equal(completingToken(parseQuery("請求 in:op"))?.value, "op");
  assert.equal(completingToken(parseQuery("請求 in:op ")), undefined);
  assert.equal(completingToken(parseQuery("from:"))?.modifier, "from");
  assert.equal(completingToken(parseQuery("in:op 請求")), undefined);
});

test("in: の候補は辞書で置き換えた名前でも当たり、チャンネルだけを出す", () => {
  const candidates = candidatesFor(filterAt("in:op_auto"), sources, SELF);
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["C100", "C200"],
  );
  // グループDMと人は in: の候補に出ない
  assert.ok(
    candidatesFor(filterAt("in:jones"), sources, SELF).every(
      (c) => c.kind !== "group" && c.kind !== "person",
    ),
  );
});

test("from: の候補は人だけで、自分（me）を先頭に出す。別名でも当たる", () => {
  assert.deepEqual(
    candidatesFor(filterAt("from:"), sources, SELF).map((c) => c.token),
    ["me", "@jones_f", "@sato_y"],
  );
  assert.deepEqual(
    candidatesFor(filterAt("to:佐藤さん"), sources, SELF).map((c) => c.token),
    ["@sato_y"],
  );
  assert.deepEqual(
    candidatesFor(filterAt("from:m"), sources, SELF).map((c) => c.token)[0],
    "me",
  );
});

test("候補を選ぶと入力中の語だけを書き換え、否定と前の文字列を保ち、空白で確定させる", () => {
  const text = "請求 -in:op_auto";
  const filter = filterAt(text);
  const [first] = candidatesFor(filter, sources, SELF);
  assert.equal(
    applyCandidate(text, filter, first),
    "請求 -in:#op_自動取得課_オペレーター ",
  );
});

test("検索式に変える。正式な語・別名・me・貼り付けた Slack の書式を ID にし、入力中の語は含めない", () => {
  const resolved = resolveQuery(
    "請求 in:#op_自動取得課_オペレーター from:@sato_y to:me -in:分報 in:<#C999|x> from:jones",
    sources,
    SELF,
  );
  assert.equal(
    resolved.query,
    `請求 in:<#C100> from:<@U600> to:<@${SELF}> -in:<#C300> in:<#C999|x>`,
  );
  assert.equal(resolved.completing?.value, "jones");
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(
    resolved.filters.map((f) => f.label),
    [
      "op_自動取得課_オペレーター",
      "佐藤 次郎",
      "自分",
      "times_example_user",
      "<#C999|x>",
    ],
  );
});

test("from:me は Slack の from:me のまま渡す", () => {
  assert.equal(
    resolveQuery("from:me 請求 ", sources, SELF).query,
    "from:me 請求",
  );
});

test("相手が決まらない絞り込みは検索式に入れず、未解決として返す", () => {
  // 部分一致（op_auto）は確定させない。複数に当たるか、意図しない相手で絞ってしまうため
  const resolved = resolveQuery("in:op_auto 請求", sources, SELF);
  assert.equal(resolved.query, "請求");
  assert.deepEqual(
    resolved.unresolved.map((t) => t.value),
    ["op_auto"],
  );
});

test("値の無い絞り込みは黙って捨てる", () => {
  assert.equal(resolveQuery("from: 請求", sources, SELF).query, "請求");
});

test("in:@相手 は、その人との DM を指す検索式 in:<@U…> にする（否定も同じ）", () => {
  const resolved = resolveQuery("in:@sato_y -in:@jones_f 請求", sources, SELF);
  assert.equal(resolved.query, "in:<@U600> -in:<@U500> 請求");
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(
    resolved.filters.map((f) => [f.modifier, f.negated, f.label]),
    [
      ["in", false, "佐藤 次郎"],
      ["in", true, "山田 三郎"],
    ],
  );
  // 別名でも引ける（人の照合語に別名が入っている）
  assert.equal(
    resolveQuery("in:@佐藤さん ", sources, SELF).query,
    "in:<@U600>",
  );
});

test("in:@相手 は、名前が同じチャンネルがあっても、人の中だけから探す。in:#名前 と、頭の記号の無い in:名前 はチャンネルのまま", () => {
  // 人のハンドル sato_y と、名前（正式名・照合語）が同じチャンネル
  const shared: FilterSource[] = [
    ...sources,
    {
      id: "C777",
      kind: "channel",
      title: "sato_y",
      keywords: ["sato_y"],
      token: "#sato_y",
    },
  ];
  assert.equal(resolveQuery("in:@sato_y ", shared, SELF).query, "in:<@U600>");
  assert.equal(resolveQuery("in:#sato_y ", shared, SELF).query, "in:<#C777>");
  assert.equal(resolveQuery("in:sato_y ", shared, SELF).query, "in:<#C777>");
  // from: は今までどおり人
  assert.equal(
    resolveQuery("from:@sato_y ", shared, SELF).query,
    "from:<@U600>",
  );
});

test("in:@相手 の相手が人の一覧に無ければ、検索式に入れず、未解決として返す。貼り付けた in:<@U…> はそのまま通す", () => {
  const unknown = resolveQuery("in:@zzz 請求", sources, SELF);
  assert.equal(unknown.query, "請求");
  assert.deepEqual(
    unknown.unresolved.map((t) => t.raw),
    ["in:@zzz"],
  );
  // チャンネルの名前を @ 付きで打っても、チャンネルには当てない（人の一覧に無いので未解決）
  assert.equal(
    resolveQuery("in:@times_example_user ", sources, SELF).unresolved.length,
    1,
  );
  assert.equal(
    resolveQuery("in:<@UGONE> 請求", sources, SELF).query,
    "in:<@UGONE> 請求",
  );
});

test("in:@ の候補は、検索式に直す側と同じく人だけを出す。確定すると in:@ハンドル になり、検索式では in:<@U…> になる", () => {
  const text = "請求 in:@sato";
  const filter = filterAt(text);
  const candidates = candidatesFor(filter, sources, SELF);
  // チャンネルとグループDM は出ない
  assert.deepEqual(
    candidates.map((c) => [c.modifier, c.token, c.kind]),
    [["in", "@sato_y", "person"]],
  );
  const applied = applyCandidate(text, filter, candidates[0]);
  assert.equal(applied, "請求 in:@sato_y ");
  // 確定した語が、検索式では、その人との DM を指す（候補で選んだ相手と、検索する相手が同じ）
  const resolved = resolveQuery(applied, sources, SELF);
  assert.equal(resolved.query, "請求 in:<@U600>");
  assert.deepEqual(resolved.unresolved, []);
});

test("in:@ の候補：否定（-in:@）も人。語が空なら人を全員出すが、in: の決まりどおり自分（me）は出さない", () => {
  const text = "請求 -in:@jones";
  const negated = filterAt(text);
  const candidates = candidatesFor(negated, sources, SELF);
  assert.deepEqual(
    candidates.map((c) => c.token),
    ["@jones_f"],
  );
  assert.equal(
    applyCandidate(text, negated, candidates[0]),
    "請求 -in:@jones_f ",
  );

  // 語が空：人だけを、候補元の並びのまま出す
  assert.deepEqual(
    candidatesFor(filterAt("in:@"), sources, SELF).map((c) => [
      c.token,
      c.kind,
    ]),
    [
      ["@jones_f", "person"],
      ["@sato_y", "person"],
    ],
  );
  // 「m」は from:・to: なら自分（me）が先頭に出る語。in:@ では出さない
  assert.deepEqual(candidatesFor(filterAt("in:@m"), sources, SELF), []);
});

test("in:@ の候補は、名前が同じチャンネルがあっても人だけ。頭の記号が無い in: と in:# は、チャンネルのまま", () => {
  const shared: FilterSource[] = [
    ...sources,
    {
      id: "C777",
      kind: "channel",
      title: "sato_y",
      keywords: ["sato_y"],
      token: "#sato_y",
    },
  ];
  assert.deepEqual(
    candidatesFor(filterAt("in:@sato"), shared, SELF).map((c) => c.token),
    ["@sato_y"],
  );
  for (const text of ["in:sato", "in:#sato"]) {
    const candidates = candidatesFor(filterAt(text), shared, SELF);
    assert.equal(candidates[0].token, "#sato_y", text);
    assert.ok(
      candidates.every((c) => c.kind === "channel" || c.kind === "private"),
      text,
    );
  }
  // from: は今までどおり人
  assert.deepEqual(
    candidatesFor(filterAt("from:sato"), shared, SELF).map((c) => c.token),
    ["@sato_y"],
  );
});

// ---- 候補の並び（お気に入り → 最近開いた順 → 一致の強さ） ----------------------------

const prefs: Prefs = {
  favorites: [],
  aliases: {},
  dictionary: [{ from: "自動取得", to: "auto" }],
  membership: "all",
};

const channel = (id: string, name: string): Conversation => ({
  id,
  name,
  type: "public",
});

const person = (id: string, handle: string, displayName: string): Person => ({
  id,
  handle,
  displayName,
  realName: displayName,
  title: "",
  isBot: false,
});

// 試験用の形：どちらも辞書で置き換えた名前（op_auto…）に前方一致して、一致の強さが同じになる。
// 名前の短い #op_自動取得github通知 のほうが、toItems の並びでは先に来る
const conversations = [
  channel("C100", "op_自動取得課_オペレーター"),
  channel("C050", "op_自動取得github通知"),
  channel("C900", "random"),
];
const people = [
  person("U1", "sato_y", "佐藤"),
  person("U2", "sato_z", "佐藤 二郎"),
];
const rows = toItems(conversations, people, prefs, SELF_HANDLES);
const ids = (cs: readonly { id: string }[]) => cs.map((c) => c.id);

test("同じ一致の強さなら、お気に入りの会話が、ほかの会話より候補の上に来る。お気に入りを外すと元の並び", () => {
  const filter = filterAt("in:op_auto");

  // お気に入りが無いと、toItems の並び（名前の短い順）のまま、github のほうが先
  const plain = candidatesFor(
    filter,
    orderSources(toFilterSources(rows, people), new Set()),
    SELF,
  );
  assert.deepEqual(ids(plain), ["C050", "C100"]);

  const favorite = candidatesFor(
    filter,
    orderSources(toFilterSources(rows, people), new Set(["C100"])),
    SELF,
  );
  assert.deepEqual(ids(favorite), ["C100", "C050"]);
  // ↵ で確定すると、入力中の語が in:#正式名 になる
  assert.equal(
    applyCandidate("in:op_auto", filter, favorite[0]),
    "in:#op_自動取得課_オペレーター ",
  );
});

test("お気に入りでない候補どうしは、渡された並び（最近開いた順）のまま。お気に入りが複数あれば、その中でも渡された並び", () => {
  const filter = filterAt("in:op_auto");
  // 3つとも前方一致で、一致の強さが同じ
  const three = toItems(
    [...conversations, channel("C060", "op_自動取得dev")],
    people,
    prefs,
    SELF_HANDLES,
  );
  // 最近開いた順（useFrecencySorting の結果）が C060 → C100 → C050 のとき
  const recent = ["C060", "C100", "C050", "C900"].map((id) =>
    three.find((r) => r.id === id)!,
  );
  const candidateIds = (favorites: string[]) =>
    ids(
      candidatesFor(
        filter,
        orderSources(toFilterSources(recent, people), new Set(favorites)),
        SELF,
      ),
    );

  assert.deepEqual(candidateIds([]), ["C060", "C100", "C050"]);
  // お気に入りが先に来て、その中も、そうでない中も、最近開いた順のまま
  assert.deepEqual(candidateIds(["C050"]), ["C050", "C060", "C100"]);
  assert.deepEqual(candidateIds(["C100", "C050"]), ["C100", "C050", "C060"]);
});

test("お気に入りが動かすのは、同じ強さの中だけ。一致の強い候補を、弱い一致のお気に入りが追い越さない", () => {
  const rowsWithWeak = toItems(
    [...conversations, channel("C700", "x_op_auto_x")],
    people,
    prefs,
    SELF_HANDLES,
  );
  // x_op_auto_x は単語の途中に当たるだけで、前方一致の2つより弱い
  const candidates = candidatesFor(
    filterAt("in:op_auto"),
    orderSources(toFilterSources(rowsWithWeak, people), new Set(["C700"])),
    SELF,
  );
  assert.deepEqual(ids(candidates), ["C050", "C100", "C700"]);
});

test("from: の候補も、お気に入りの人が同じ強さのほかの人より上に来る", () => {
  const filter = filterAt("from:sato");
  assert.deepEqual(
    candidatesFor(
      filter,
      orderSources(toFilterSources(rows, people), new Set()),
      SELF,
    ).map((c) => c.token),
    ["@sato_y", "@sato_z"],
  );
  assert.deepEqual(
    candidatesFor(
      filter,
      orderSources(toFilterSources(rows, people), new Set(["U2"])),
      SELF,
    ).map((c) => c.token),
    ["@sato_z", "@sato_y"],
  );
});

test("ファジー候補を選ぶと正式な語になり、確定前には宛先を自動解決しない", () => {
  const pool: FilterSource[] = [
    {
      id: "C1",
      kind: "channel",
      title: "doc_automate",
      keywords: ["doc_automate"],
      token: "#doc_automate",
    },
    {
      id: "U1",
      kind: "person",
      title: "Example User",
      keywords: ["example_user"],
      token: "@example_user",
    },
  ];
  for (const input of [
    "in:dca",
    "in:doc_autmate",
    "from:exampel_user",
    "to:exampel_user",
    "-from:exampel_user",
  ]) {
    const filter = filterAt(input);
    const candidates = candidatesFor(filter, pool, SELF);
    assert.equal(candidates.length, 1, input);
    const resolved = resolveQuery(
      applyCandidate(input, filter, candidates[0]),
      pool,
      SELF,
    );
    assert.equal(resolved.unresolved.length, 0, input);
    assert.equal(resolved.filters.length, 1, input);
    assert.equal(
      resolveQuery(`${input} `, pool, SELF).unresolved.length,
      1,
      input,
    );
  }
  assert.deepEqual(candidatesFor(filterAt("in:exampel_user"), pool, SELF), []);
  assert.deepEqual(candidatesFor(filterAt("from:doc_autmate"), pool, SELF), []);
});
