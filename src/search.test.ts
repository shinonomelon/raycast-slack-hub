import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDictionary,
  filterByMembership,
  nextMembership,
  mpimDisplayName,
  mpimHandles,
  normalize,
  orderItems,
  rankItems,
  type Item,
} from "./search.ts";

const item = (id: string, ...keywords: string[]): Item => ({
  id,
  kind: "channel",
  title: keywords[0],
  keywords,
});

test("空の検索語なら元の並びのまま上限まで返す", () => {
  const items = [item("1", "a"), item("2", "b"), item("3", "c")];
  assert.deepEqual(
    rankItems(items, "  ", 2).map((i) => i.id),
    ["1", "2"],
  );
});

test("完全一致 > 前方一致 > 単語の先頭一致 > 部分一致の順に並べる", () => {
  const items = [
    item("sub", "pdoc"),
    item("word", "team_doc"),
    item("prefix", "doc_automate"),
    item("exact", "doc"),
    item("none", "random"),
  ];
  assert.deepEqual(
    rankItems(items, "doc").map((i) => i.id),
    ["exact", "prefix", "word", "sub"],
  );
});

test("同じ強さなら元の並び（最近開いた順）を保つ", () => {
  const items = [item("b", "doc_b"), item("a", "doc_a")];
  assert.deepEqual(
    rankItems(items, "doc").map((i) => i.id),
    ["b", "a"],
  );
});

test("全角や大文字でも当たる", () => {
  assert.equal(normalize("ＤＯＣ_Auto"), "doc_auto");
  assert.deepEqual(
    rankItems([item("1", "doc_automate")], "ＤＯＣ").map((i) => i.id),
    ["1"],
  );
});

test("複数の単語はすべて当たるものだけ残す", () => {
  const items = [item("1", "dev_doc_automate"), item("2", "dev_random")];
  assert.deepEqual(
    rankItems(items, "dev auto").map((i) => i.id),
    ["1"],
  );
});

test("人の名前は空白を詰めても当たる", () => {
  const person: Item = {
    id: "U1",
    kind: "person",
    title: "田中 太郎",
    keywords: ["田中 太郎", "example_user"],
  };
  assert.deepEqual(
    rankItems([person], "田中太郎").map((i) => i.id),
    ["U1"],
  );
  assert.deepEqual(
    rankItems([person], "太郎").map((i) => i.id),
    ["U1"],
  );
});

test("上限を超えたら強い順に切る", () => {
  const items = [item("sub", "xdoc"), item("exact", "doc")];
  assert.deepEqual(
    rankItems(items, "doc", 1).map((i) => i.id),
    ["exact"],
  );
});

test("グループDMの名前を参加者の表示名にする", () => {
  const names = new Map([
    ["jones_f", "山田"],
    ["sato_y", "佐藤"],
  ]);
  assert.equal(
    mpimDisplayName("mpdm-jones_f--sato_y--unknown--example_old-1", names, [
      "example_old",
      "example_user",
    ]),
    "山田, 佐藤, unknown",
  );
});

test("グループDMのハンドルから自分を除く", () => {
  assert.deepEqual(
    mpimHandles("mpdm-jones_f--example_old--sato_y-1", [
      "example_old",
      "example_user",
    ]),
    ["jones_f", "sato_y"],
  );
});

test("辞書の規則を当てた名前で、自分の呼び方から引ける", () => {
  const rules = [{ from: "自動取得", to: "auto" }];
  const names = [
    "op_remote_op_自動取得",
    "op_自動取得課_オペレーター",
    "op_自動取得github通知",
    "op_メール取得_質問用",
  ];
  const items = names.map((n) => item(n, n, applyDictionary(n, rules)));
  assert.deepEqual(
    rankItems(items, "op_auto").map((i) => i.id),
    [
      "op_自動取得課_オペレーター",
      "op_自動取得github通知",
      "op_remote_op_自動取得",
    ],
  );
});

test("辞書は長い規則から当てる", () => {
  assert.equal(
    applyDictionary("op_自動取得課", [
      { from: "取得", to: "get" },
      { from: "自動取得", to: "auto" },
    ]),
    "op_auto課",
  );
});

test("辞書の空の規則は無視し、全角半角をそろえる", () => {
  assert.equal(
    applyDictionary("ＯＰ_自動取得", [
      { from: "", to: "x" },
      { from: "自動取得", to: "AUTO" },
    ]),
    "op_auto",
  );
});

test("お気に入りを先に並べ、ほかの並びは保つ", () => {
  const items = [item("a", "a"), item("b", "b"), item("c", "c")];
  assert.deepEqual(
    orderItems(items, new Set(["c"])).map((i) => i.id),
    ["c", "a", "b"],
  );
});

test("同じ強さならお気に入りが上に来る", () => {
  const items = [item("x", "doc_x"), item("fav", "doc_fav")];
  assert.deepEqual(
    rankItems(orderItems(items, new Set(["fav"])), "doc").map((i) => i.id),
    ["fav", "x"],
  );
});

test("参加しているかで絞る。人は「すべて」と、未読の DM があるときの参加中にだけ出す", () => {
  const items: Item[] = [
    { id: "C1", kind: "channel", title: "joined", keywords: [] },
    { id: "C2", kind: "channel", title: "not-joined", keywords: [] },
    { id: "G1", kind: "private", title: "private", keywords: [] },
    { id: "M1", kind: "group", title: "group", keywords: [] },
    { id: "U1", kind: "person", title: "person", keywords: [] },
  ];
  const joined = new Set(["C1"]);
  const ids = (m: "all" | "joined" | "notJoined") =>
    filterByMembership(items, m, joined).map((i) => i.id);
  assert.deepEqual(ids("all"), ["C1", "C2", "G1", "M1", "U1"]);
  assert.deepEqual(ids("joined"), ["C1", "G1", "M1"]);
  assert.deepEqual(ids("notJoined"), ["C2"]);
  // 未読の DM がある人は参加中にだけ出る
  const unread = new Set(["U1"]);
  const withUnread = (m: "joined" | "notJoined") =>
    filterByMembership(items, m, joined, unread).map((i) => i.id);
  assert.deepEqual(withUnread("joined"), ["C1", "G1", "M1", "U1"]);
  assert.deepEqual(withUnread("notJoined"), ["C2"]);
});

test("絞り込みは すべて → 参加中 → 未参加 → すべて の順に切り替わる", () => {
  assert.equal(nextMembership("all"), "joined");
  assert.equal(nextMembership("joined"), "notJoined");
  assert.equal(nextMembership("notJoined"), "all");
});

test("未読を先に、その中と外でお気に入りを先に並べる", () => {
  const items = [
    item("plain", "plain"),
    item("fav", "fav"),
    item("unread", "unread"),
    item("both", "both"),
  ];
  assert.deepEqual(
    orderItems(
      items,
      new Set(["fav", "both"]),
      new Set(["unread", "both"]),
    ).map((i) => i.id),
    ["both", "unread", "fav", "plain"],
  );
});

test("一致の強さが同じなら未読が上、強さが違えば一致の強さを優先する", () => {
  const items = [item("exact", "doc"), item("x", "doc_x"), item("u", "doc_u")];
  assert.deepEqual(
    rankItems(orderItems(items, new Set(), new Set(["u"])), "doc").map(
      (i) => i.id,
    ),
    ["exact", "u", "x"],
  );
});

test("飛び飛び入力と英数字の1文字の誤字で名前を探せる", () => {
  const items = [item("doc", "doc_automate")];
  for (const query of [
    "dca",
    "doc_autmate",
    "doc_auotmate",
    "doc_automatte",
    "doc_autxmate",
    "autmate",
  ]) {
    assert.deepEqual(
      rankItems(items, query).map((i) => i.id),
      ["doc"],
      query,
    );
  }
});

test("既存の一致を誤字と飛び飛び一致より上にし、既存の同順位を保つ", () => {
  const items = [
    item("skip-wide", "a_u_t_o"),
    item("typo", "autp"),
    item("sub", "xauto"),
    item("word", "doc_auto"),
    item("prefix-b", "auto_b"),
    item("prefix-a", "auto_a"),
    item("exact", "auto"),
    item("skip-tight", "a_uto"),
  ];
  assert.deepEqual(
    rankItems(items, "auto").map((i) => i.id),
    [
      "exact",
      "prefix-b",
      "prefix-a",
      "word",
      "sub",
      "typo",
      "skip-tight",
      "skip-wide",
    ],
  );
  assert.deepEqual(
    rankItems(items, "auto", 2).map((i) => i.id),
    ["exact", "prefix-b"],
  );
});

test("短い語・広い間隔・順序違い・2箇所の誤字を新しい一致にしない", () => {
  assert.deepEqual(rankItems([item("1", "a_b")], "ab"), []);
  assert.deepEqual(rankItems([item("1", "cat")], "cta"), []);
  assert.deepEqual(rankItems([item("1", "d____c____a")], "dca"), []);
  assert.deepEqual(rankItems([item("1", "doc_automate")], "acd"), []);
  assert.deepEqual(rankItems([item("1", "automate")], "xutomatz"), []);
  // 誤字補正は長い単語の任意の部分には当てない。
  assert.deepEqual(rankItems([item("1", "zzautpzz")], "auto"), []);
});

test("飛び飛び一致は最短区間を選び、Unicodeの文字単位で数える", () => {
  assert.deepEqual(
    rankItems([item("1", "a_____a_bc")], "abc").map((i) => i.id),
    ["1"],
  );
  assert.deepEqual(
    rankItems([item("1", "𠮷_野_家")], "𠮷野家").map((i) => i.id),
    ["1"],
  );
  assert.deepEqual(rankItems([item("1", "田中太郎")], "原田太郎"), []);
  assert.deepEqual(
    rankItems([item("1", "doc_automate")], "ＤＣＡ").map((i) => i.id),
    ["1"],
  );
});

test("別名・辞書・複数語でもファジー検索が効き、全単語の一致を要する", () => {
  const items = [
    item("1", "team_channel", "doc_automate"),
    item("2", "other", "doc_automate"),
  ];
  assert.deepEqual(
    rankItems(items, "team dca").map((i) => i.id),
    ["1"],
  );
  assert.deepEqual(rankItems(items, "team missing"), []);
  const translated = applyDictionary("op_自動取得", [
    { from: "自動取得", to: "automate" },
  ]);
  assert.deepEqual(
    rankItems([item("1", "op_自動取得", translated)], "autmate").map(
      (i) => i.id,
    ),
    ["1"],
  );
});

test("ファジーの同順位でも未読・お気に入りの元の順を保つ", () => {
  const items = [
    item("plain", "doc_automate"),
    item("fav", "doc_automate"),
    item("unread", "doc_automate"),
  ];
  assert.deepEqual(
    rankItems(
      orderItems(items, new Set(["fav"]), new Set(["unread"])),
      "dca",
    ).map((i) => i.id),
    ["unread", "fav", "plain"],
  );
});

test("飛び飛び一致で同じ文字を再利用せず、区間上限の境界を守る", () => {
  assert.deepEqual(rankItems([item("1", "a_a")], "aaa"), []);
  assert.deepEqual(rankItems([item("1", "𠮷_家")], "𠮷家"), []);
  assert.deepEqual(
    rankItems([item("1", "a__b_c")], "abc").map((i) => i.id),
    ["1"],
  );
  assert.deepEqual(rankItems([item("1", "a__b__c")], "abc"), []);
});
