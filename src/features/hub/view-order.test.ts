import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import { toFilterSources, toItems, type Row } from "../../slack/items.ts";
import { resolveQuery } from "../search/query.ts";
import type { SearchStatus } from "../search/search-gate.ts";
import type { Conversation, Person, Prefs } from "../../shared/types.ts";
import {
  afterTextChange,
  candidateRowId,
  COMMON_ACTIONS,
  conversationQuery,
  conversationRowId,
  decideSelection,
  filterForHitConversation,
  filterForRow,
  filterForSender,
  firstSection,
  hasFilterToken,
  messageRowId,
  overrideAfterTextChange,
  requestFirstRow,
  sectionOrder,
  standaloneActions,
  STATUS_ROW_ID,
  textWithFilter,
  toggleOverride,
  triageRowId,
  warningRowId,
  type CommonAction,
  type FilterRow,
  type OrderedSection,
  type SelectionView,
  type StandaloneRow,
} from "./view-order.ts";

const SELF = "U0000000013";
// 自分のハンドル（auth.test の user と Previous Handles）。グループDMの名前から自分を除く
const SELF_HANDLES = ["example_user", "example_old"];

// ---- セクションの順 ----------------------------------------------------------------

test("絞り込み語（from:・to:・in:）があるかを見分ける。否定・入力中は数え、after: などと引用符の中は数えない", () => {
  for (const text of [
    "in:#a",
    "請求 from:@sato_y",
    "to:me",
    "-in:#a",
    "in:op", // 入力中でも数える
    "請求 in：op", // 全角のコロン
    "from:", // 値が空でも、打ち始めた
  ]) {
    assert.equal(hasFilterToken(text), true, text);
  }
  for (const text of [
    "",
    "請求",
    "after:2026-09-01 請求",
    "has:link is:unread",
    '"in:foo"',
    "min:3", // in: で終わる語（min:）は絞り込みではない
  ]) {
    assert.equal(hasFilterToken(text), false, text);
  }
});

test("検索欄が空なら自分宛てが先、絞り込み語が無ければ会話が先、あればメッセージが先になる", () => {
  // 検索欄が空（空白だけも）：メッセージの検索ではなく、自分宛ての整理が先
  assert.equal(firstSection("", undefined), "triage");
  assert.equal(firstSection("  ", undefined), "triage");
  assert.equal(firstSection("請求", undefined), "conversations");
  assert.equal(
    firstSection("after:2026-09-01 請求", undefined),
    "conversations",
  );
  assert.equal(firstSection("in:#a 請求", undefined), "messages");
  assert.equal(firstSection("from:@sato_y", undefined), "messages");
});

test("Shift+Tab で入れ替わり、もう一度押すと戻り、検索欄を空にすると入れ替えが解除される", () => {
  // 絞り込み語が無いとき：会話 → メッセージ → 会話
  let override: OrderedSection | undefined;
  override = toggleOverride("請求", override);
  assert.equal(firstSection("請求", override), "messages");
  override = toggleOverride("請求", override);
  assert.equal(firstSection("請求", override), "conversations");
  // 元の順に戻ったときは、入れ替え中の印を持たない
  assert.equal(override, undefined);

  // 絞り込み語があるとき：メッセージ → 会話 → メッセージ
  override = toggleOverride("in:#a 請求", undefined);
  assert.equal(firstSection("in:#a 請求", override), "conversations");
  override = toggleOverride("in:#a 請求", override);
  assert.equal(firstSection("in:#a 請求", override), "messages");
  assert.equal(override, undefined);

  // 入れ替えたあと、検索欄を空にすると解除される。文字が残っているあいだは保つ
  const swapped = toggleOverride("請求", undefined);
  assert.equal(swapped, "messages");
  assert.equal(overrideAfterTextChange("請求書", swapped), "messages");
  assert.equal(overrideAfterTextChange("", swapped), undefined);
  assert.equal(overrideAfterTextChange("  ", swapped), undefined);
  assert.equal(firstSection("", undefined), "triage");
});

test("メッセージを先にしたまま、Tab で in: を足しても、会話に戻らない", () => {
  // 絞り込み語が無いまま Shift+Tab でメッセージを先にする
  const override = toggleOverride("請求", undefined);
  assert.equal(override, "messages");
  // in: を足すと、既定の順もメッセージが先になる。入れ替えの印が残っていても、会話が先に戻らない
  const text = textWithFilter("請求", "in:#example_remind", "message");
  assert.equal(
    firstSection(text, overrideAfterTextChange(text, override)),
    "messages",
  );
  // この状態でもう一度 Shift+Tab を押すと、会話が先になる
  assert.equal(
    firstSection(text, toggleOverride(text, override)),
    "conversations",
  );
});

test("検索欄が空のときは自分宛てが先、Shift+Tab で会話が先になり、もう一度押すと自分宛てに戻る", () => {
  let override: OrderedSection | undefined;
  override = toggleOverride("", override);
  assert.equal(override, "conversations");
  assert.equal(firstSection("", override), "conversations");
  // 元の順（自分宛てが先）に戻ったときは、入れ替え中の印を持たない
  override = toggleOverride("", override);
  assert.equal(override, undefined);
  assert.equal(firstSection("", override), "triage");
  // 空白だけの検索欄も空欄と同じ
  assert.equal(toggleOverride("  ", undefined), "conversations");
});

test("空欄の一覧には、メッセージの検索結果を出さない。文字のある一覧には、自分宛てを出さない（古い入れ替えの印が残っていても）", () => {
  const overrides: (OrderedSection | undefined)[] = [
    undefined,
    "triage",
    "messages",
    "conversations",
  ];
  for (const override of overrides) {
    // 検索欄が空：自分宛てと会話の2つだけ
    assert.deepEqual(
      [...sectionOrder("", override, false)].sort(),
      ["conversations", "triage"],
      String(override),
    );
    // 文字がある：会話とメッセージの2つだけ
    assert.deepEqual(
      [...sectionOrder("請求", override, false)].sort(),
      ["conversations", "messages"],
      String(override),
    );
  }
});

test("空欄から打ち始めたら、空欄での入れ替え（会話が先）は解除される。文字がある状態からの変更では保つ", () => {
  // 空欄で Shift+Tab を押して、会話を先にした
  const swapped = toggleOverride("", undefined);
  assert.equal(swapped, "conversations");
  // 打ち始めた：解除。持ち越すと、in: を足したのに、メッセージでなく会話が先のままになる
  assert.equal(overrideAfterTextChange("in:", swapped, ""), undefined);
  assert.equal(firstSection("in:", undefined), "messages");
  assert.equal(overrideAfterTextChange("a", swapped, "  "), undefined);
  // 文字がある状態からの変更は、これまでどおり保つ
  assert.equal(
    overrideAfterTextChange("請求書", "messages", "請求"),
    "messages",
  );
  // 変える前の文字を渡さなければ、検索欄が空になったかだけを見る
  assert.equal(overrideAfterTextChange("請求書", "messages"), "messages");
  assert.equal(overrideAfterTextChange("", "messages", "請求"), undefined);
});

test("セクションの順：候補があればいちばん上、そのあとに、先に出すものとその残り", () => {
  // 検索欄が空：自分宛てが先、Shift+Tab で会話が先
  assert.deepEqual(sectionOrder("", undefined, false), [
    "triage",
    "conversations",
  ]);
  assert.deepEqual(sectionOrder("", "conversations", false), [
    "conversations",
    "triage",
  ]);
  assert.deepEqual(sectionOrder("請求", undefined, false), [
    "conversations",
    "messages",
  ]);
  assert.deepEqual(sectionOrder("請求 in:#a ", undefined, false), [
    "messages",
    "conversations",
  ]);
  // 候補は、入れ替えても、いつもいちばん上
  assert.deepEqual(sectionOrder("in:op", undefined, true), [
    "candidates",
    "messages",
    "conversations",
  ]);
  assert.deepEqual(sectionOrder("in:op", "conversations", true), [
    "candidates",
    "conversations",
    "messages",
  ]);
});

test("会話の一覧を絞る語は、絞り込みと after: などを除いた語（引用符は外す）", () => {
  assert.equal(
    conversationQuery("請求 in:#a from:@sato_y after:2026-09-01"),
    "請求",
  );
  assert.equal(conversationQuery("in:#a "), "");
  assert.equal(conversationQuery('"請求 書" -in:#a 確認'), "請求 書 確認");
  assert.equal(conversationQuery("asobiba"), "asobiba");
});

// ---- 検索欄に足す絞り込み ------------------------------------------------------------

const prefs: Prefs = {
  favorites: [],
  aliases: {},
  dictionary: [],
  membership: "all",
};

const person = (id: string, handle: string, displayName: string): Person => ({
  id,
  handle,
  displayName,
  realName: displayName,
  title: "",
  isBot: false,
});

const conversations: Conversation[] = [
  { id: "C100", name: "project_資料管理課_共同作業メンバー", type: "public" },
  { id: "G200", name: "times_example_user", type: "private" },
  {
    id: "G300",
    name: "mpdm-example_user--sato_y--jones_f-1",
    type: "mpim",
  },
];
const people = [
  person("U1", "sato_y", "佐藤"),
  person("U2", "jones_f", "山田"),
];
const rows = toItems(conversations, people, prefs, SELF_HANDLES);
const sources = toFilterSources(rows, people);
const tokenOf = (id: string) => sources.find((s) => s.id === id)?.token;
const rowOf = (id: string): Row => {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, id);
  return row;
};

// 行から足す文字を作り、空の検索欄に足し、検索式に直すまで通す。
// 既定は会話・人の行。メッセージの行のテストは messageFilterQuery を使う
const filterQuery = (
  filter: string | undefined,
  row: FilterRow = "conversation",
) => {
  assert.ok(filter);
  const text = textWithFilter("", filter, row);
  return { text, query: resolveQuery(text, sources, SELF).query };
};
const messageFilterQuery = (filter: string | undefined) =>
  filterQuery(filter, "message");

test("検索欄の末尾に足すときは、前の文字と空白で区切り、末尾の空白で確定させる", () => {
  // メッセージの行：検索の語を残して足す
  assert.equal(textWithFilter("", "in:#a", "message"), "in:#a ");
  assert.equal(textWithFilter("請求", "in:#a", "message"), "請求 in:#a ");
  assert.equal(textWithFilter("請求   ", "in:#a", "message"), "請求 in:#a ");
  assert.equal(textWithFilter("  請求", "in:#a", "message"), "請求 in:#a ");
  assert.equal(textWithFilter("   ", "in:#a", "message"), "in:#a ");
  // 語の間の空白は1つにそろう
  assert.equal(
    textWithFilter("請求   書", "in:#a", "message"),
    "請求 書 in:#a ",
  );
  // 会話・人の行：検索の語は外れるので、足す語だけになる
  assert.equal(textWithFilter("", "in:#a", "conversation"), "in:#a ");
  assert.equal(textWithFilter("請求", "in:#a", "conversation"), "in:#a ");
  assert.equal(textWithFilter("請求   ", "in:#a", "conversation"), "in:#a ");
  assert.equal(textWithFilter("  請求", "in:#a", "conversation"), "in:#a ");
  assert.equal(textWithFilter("   ", "in:#a", "conversation"), "in:#a ");
});

test("会話の行は in:#名前、人の行は from:@名前、グループDM の行は in:<#ID> が末尾に付き、検索式に直せる", () => {
  assert.deepEqual(filterQuery(filterForRow(rowOf("C100"), tokenOf)), {
    text: "in:#project_資料管理課_共同作業メンバー ",
    query: "in:<#C100>",
  });
  assert.deepEqual(filterQuery(filterForRow(rowOf("G200"), tokenOf)), {
    text: "in:#times_example_user ",
    query: "in:<#G200>",
  });
  assert.deepEqual(filterQuery(filterForRow(rowOf("U1"), tokenOf)), {
    text: "from:@sato_y ",
    query: "from:<@U1>",
  });
  assert.deepEqual(filterQuery(filterForRow(rowOf("G300"), tokenOf)), {
    text: "in:<#G300> ",
    query: "in:<#G300>",
  });
});

test("候補元に無い人・チャンネルの行は、Slack の書式の ID をそのまま足す", () => {
  assert.equal(
    filterForRow({ id: "UGONE", kind: "person" }, tokenOf),
    "from:<@UGONE>",
  );
  assert.equal(
    filterForRow({ id: "CGONE", kind: "channel" }, tokenOf),
    "in:<#CGONE>",
  );
  assert.deepEqual(
    filterQuery(filterForRow({ id: "UGONE", kind: "person" }, tokenOf)),
    { text: "from:<@UGONE> ", query: "from:<@UGONE>" },
  );
});

const hitIn = (
  overrides: Partial<Hit>,
): Pick<Hit, "channelId" | "channelKind" | "channelName"> => ({
  channelId: "C100",
  channelKind: "channel",
  channelName: undefined,
  ...overrides,
});

test("メッセージの行：チャンネルは in:#名前、DM は in:@相手、グループDM は in:<#ID>。DM の in:@相手 は検索式で in:<@U…> になる", () => {
  assert.deepEqual(
    messageFilterQuery(
      filterForHitConversation(
        hitIn({
          channelId: "C100",
          channelName: "project_資料管理課_共同作業メンバー",
        }),
        tokenOf,
      ),
    ),
    { text: "in:#project_資料管理課_共同作業メンバー ", query: "in:<#C100>" },
  );
  // 非公開チャンネル
  assert.deepEqual(
    messageFilterQuery(
      filterForHitConversation(
        hitIn({ channelId: "G200", channelKind: "private" }),
        tokenOf,
      ),
    ),
    { text: "in:#times_example_user ", query: "in:<#G200>" },
  );
  // DM：channel.name は相手のユーザー ID
  assert.deepEqual(
    messageFilterQuery(
      filterForHitConversation(
        hitIn({ channelId: "D1", channelKind: "im", channelName: "U1" }),
        tokenOf,
      ),
    ),
    { text: "in:@sato_y ", query: "in:<@U1>" },
  );
  // グループDM
  assert.deepEqual(
    messageFilterQuery(
      filterForHitConversation(
        hitIn({ channelId: "G300", channelKind: "mpim" }),
        tokenOf,
      ),
    ),
    { text: "in:<#G300> ", query: "in:<#G300>" },
  );
});

test("DM の相手が人の一覧に無い（削除済み・外部の人・ボット）ときは in:<@U…> を足す。相手が分からない DM と、一覧に無いチャンネルも扱える", () => {
  assert.deepEqual(
    messageFilterQuery(
      filterForHitConversation(
        hitIn({ channelId: "D2", channelKind: "im", channelName: "UGONE" }),
        tokenOf,
      ),
    ),
    { text: "in:<@UGONE> ", query: "in:<@UGONE>" },
  );
  // 相手の ID が無い DM は、絞れない
  assert.equal(
    filterForHitConversation(
      hitIn({ channelId: "D3", channelKind: "im", channelName: undefined }),
      tokenOf,
    ),
    undefined,
  );
  // 会話の一覧に無いチャンネルは、ID で絞る
  assert.equal(
    filterForHitConversation(hitIn({ channelId: "CGONE" }), tokenOf),
    "in:<#CGONE>",
  );
});

test("メッセージの行の送信者で絞る語：人は from:@ハンドル、一覧に無い人は from:<@U…>、ID の無い bot の投稿は絞れない", () => {
  assert.deepEqual(
    messageFilterQuery(filterForSender({ userId: "U2" }, tokenOf)),
    {
      text: "from:@jones_f ",
      query: "from:<@U2>",
    },
  );
  assert.equal(filterForSender({ userId: "UBOT" }, tokenOf), "from:<@UBOT>");
  assert.equal(filterForSender({ userId: undefined }, tokenOf), undefined);
});

// ---- Tab・⌘F で足す前に外す語 ---------------------------------------------------------

// @sato が実在のハンドルで、#example_remind がある一覧。上の共通の一覧は変えずに、ここだけで使う
const acPeople = [person("U10", "sato", "佐藤")];
const acConversations: Conversation[] = [
  { id: "C10", name: "example_remind", type: "public" },
  { id: "C11", name: "project_資料管理課_共同作業メンバー", type: "public" },
];
const acRows = toItems(acConversations, acPeople, prefs, SELF_HANDLES);
const acSources = toFilterSources(acRows, acPeople);
const acTokenOf = (id: string) => acSources.find((s) => s.id === id)?.token;
const acRow = (id: string): Row => {
  const row = acRows.find((r) => r.id === id);
  assert.ok(row, id);
  return row;
};

// いまの検索欄に、行の絞り込みを足し、検索式に直すまで通す
const addedTo = (text: string, filter: string | undefined, row: FilterRow) => {
  assert.ok(filter);
  const next = textWithFilter(text, filter, row);
  return { text: next, query: resolveQuery(next, acSources, SELF).query };
};

test("会話の行：検索の語（探すのに打った名前）と入力中の絞り込み語を外し、確定した絞り込みと after: は残す", () => {
  const example = filterForRow(acRow("C10"), acTokenOf);
  const op = filterForRow(acRow("C11"), acTokenOf);
  // 名前で会話を探して Tab：その名前は、メッセージの検索語として残らない
  assert.deepEqual(addedTo("example", example, "conversation"), {
    text: "in:#example_remind ",
    query: "in:<#C10>",
  });
  // 確定した from: は残り、入力中の in:op は外れる
  assert.deepEqual(addedTo("from:@sato in:op", op, "conversation"), {
    text: "from:@sato in:#project_資料管理課_共同作業メンバー ",
    query: "from:<@U10> in:<#C11>",
  });
  // after: などの修飾子は残る
  assert.deepEqual(
    addedTo("after:2026-10-01 example", example, "conversation"),
    {
      text: "after:2026-10-01 in:#example_remind ",
      query: "after:2026-10-01 in:<#C10>",
    },
  );
  // 空白で終わっていれば、その絞り込みは確定している。外れずに残る
  assert.equal(
    addedTo(
      "in:#project_資料管理課_共同作業メンバー example ",
      example,
      "conversation",
    ).text,
    "in:#project_資料管理課_共同作業メンバー in:#example_remind ",
  );
  // 入力中の否定（-in:）も外れる
  assert.equal(
    addedTo("-in:op", example, "conversation").text,
    "in:#example_remind ",
  );
});

test("会話の行：外れる検索の語は、会話の一覧を探すのに使う語（引用符の句・-語を含む）と同じ。足したあとに探す語は残らず、元の順の絞り込みと修飾子は残る", () => {
  const example = filterForRow(acRow("C10"), acTokenOf);
  for (const text of [
    '"請求 書" -draft example',
    "請求 example",
    "example from:@sato after:2026-10-01",
    "in:op example",
  ]) {
    const { text: next } = addedTo(text, example, "conversation");
    assert.equal(conversationQuery(next), "", text);
  }
  assert.equal(
    addedTo('"請求 書" -draft example', example, "conversation").text,
    "in:#example_remind ",
  );
  assert.equal(
    addedTo("example from:@sato after:2026-10-01", example, "conversation")
      .text,
    "from:@sato after:2026-10-01 in:#example_remind ",
  );
});

test("人の行：打った名前が外れて、from:@ハンドル だけになる。修飾子は残る", () => {
  const sato = filterForRow(acRow("U10"), acTokenOf);
  assert.deepEqual(addedTo("佐藤", sato, "conversation"), {
    text: "from:@sato ",
    query: "from:<@U10>",
  });
  assert.deepEqual(addedTo("佐藤 after:2026-10-01", sato, "conversation"), {
    text: "after:2026-10-01 from:@sato ",
    query: "after:2026-10-01 from:<@U10>",
  });
});

test("メッセージの行：検索の語は残し、入力中の絞り込み語だけを外して、その会話・送信者を足す", () => {
  const inHarano = filterForHitConversation(
    hitIn({ channelId: "C10", channelName: "example_remind" }),
    acTokenOf,
  );
  assert.deepEqual(addedTo("請求", inHarano, "message"), {
    text: "請求 in:#example_remind ",
    query: "請求 in:<#C10>",
  });
  // 入力中の in:op は外れる
  assert.deepEqual(addedTo("請求 in:op", inHarano, "message"), {
    text: "請求 in:#example_remind ",
    query: "請求 in:<#C10>",
  });
  // 確定した絞り込みと after: は、検索の語と一緒に、元の順のまま残る
  assert.deepEqual(
    addedTo("請求 from:@sato after:2026-10-01 in:op", inHarano, "message"),
    {
      text: "請求 from:@sato after:2026-10-01 in:#example_remind ",
      query: "請求 from:<@U10> after:2026-10-01 in:<#C10>",
    },
  );
  // DM の行：入力中の in:@ が外れ、in:@相手 になる
  const inDm = filterForHitConversation(
    hitIn({ channelId: "D10", channelKind: "im", channelName: "U10" }),
    acTokenOf,
  );
  assert.deepEqual(addedTo("請求 in:@an", inDm, "message"), {
    text: "請求 in:@sato ",
    query: "請求 in:<@U10>",
  });
  // 送信者で絞る：入力中の from: が外れる
  const sender = filterForSender({ userId: "U10" }, acTokenOf);
  assert.deepEqual(addedTo("請求 from:an", sender, "message"), {
    text: "請求 from:@sato ",
    query: "請求 from:<@U10>",
  });
});

test("同じ絞り込み語がもうあれば、足さずに、残す語だけを並べる（Tab を続けて押しても、同じ語が重ならない）", () => {
  const example = filterForRow(acRow("C10"), acTokenOf);
  const op = filterForRow(acRow("C11"), acTokenOf);
  const sato = filterForRow(acRow("U10"), acTokenOf);

  // 会話の行：in:#example_remind があるところで、同じ行の Tab → そのまま
  assert.deepEqual(addedTo("in:#example_remind ", example, "conversation"), {
    text: "in:#example_remind ",
    query: "in:<#C10>",
  });
  // 入力中の語（in:op）は外れ、同じ語は重ならない
  assert.deepEqual(
    addedTo("in:#example_remind in:op", example, "conversation"),
    {
      text: "in:#example_remind ",
      query: "in:<#C10>",
    },
  );
  // 違う会話の行なら、今までどおり足す
  assert.deepEqual(addedTo("in:#example_remind ", op, "conversation"), {
    text: "in:#example_remind in:#project_資料管理課_共同作業メンバー ",
    query: "in:<#C10> in:<#C11>",
  });
  // Tab を続けて3回押しても、1つのまま
  let text = "";
  for (let i = 0; i < 3; i++)
    text = textWithFilter(text, example, "conversation");
  assert.equal(text, "in:#example_remind ");

  // 人の行も同じ。確定した別の絞り込みと修飾子は、元の順のまま残る
  assert.deepEqual(addedTo("from:@sato ", sato, "conversation"), {
    text: "from:@sato ",
    query: "from:<@U10>",
  });
  assert.equal(
    addedTo(
      "after:2026-10-01 from:@sato in:#example_remind ",
      sato,
      "conversation",
    ).text,
    "after:2026-10-01 from:@sato in:#example_remind ",
  );

  // メッセージの行：検索の語は残り、同じ絞り込み語は重ならない
  const inHarano = filterForHitConversation(
    hitIn({ channelId: "C10", channelName: "example_remind" }),
    acTokenOf,
  );
  assert.deepEqual(addedTo("請求 in:#example_remind ", inHarano, "message"), {
    text: "請求 in:#example_remind ",
    query: "請求 in:<#C10>",
  });
  assert.deepEqual(
    addedTo("請求 in:#example_remind in:op", inHarano, "message"),
    {
      text: "請求 in:#example_remind ",
      query: "請求 in:<#C10>",
    },
  );
  // 送信者で絞る操作も同じ関数を通るので、同じ
  const sender = filterForSender({ userId: "U10" }, acTokenOf);
  assert.deepEqual(addedTo("請求 from:@sato ", sender, "message"), {
    text: "請求 from:@sato ",
    query: "請求 from:<@U10>",
  });
});

test("同じ語かは、検索欄の語そのもので見る：否定の -in:#名前 は別の語なので、足す", () => {
  const example = filterForRow(acRow("C10"), acTokenOf);
  assert.equal(
    addedTo("-in:#example_remind ", example, "conversation").text,
    "-in:#example_remind in:#example_remind ",
  );
  // 空白で終わっていない最後の絞り込み語は、入力中なので外れてから足す。打ち終える前に Tab を押しても、同じ語は1つ
  assert.equal(
    addedTo("in:#example_remind", example, "message").text,
    "in:#example_remind ",
  );
});

// ---- 行の id --------------------------------------------------------------------------

test("行の id は、セクションをまたいで重複しない（同じ ID の会話・人・メッセージ・候補・警告・状態が並んでも）", () => {
  const ids = [
    conversationRowId({ id: "C100", kind: "channel" }),
    conversationRowId({ id: "G200", kind: "private" }),
    conversationRowId({ id: "G300", kind: "group" }),
    conversationRowId({ id: "U1", kind: "person" }),
    // 人の行と同じユーザー ID を持つ候補（自分: me と、自分の人の行）も区別できる
    candidateRowId({ negated: false, modifier: "from", token: "me" }),
    candidateRowId({ negated: false, modifier: "from", token: "@sato_y" }),
    candidateRowId({ negated: true, modifier: "from", token: "@sato_y" }),
    candidateRowId({
      negated: false,
      modifier: "in",
      token: "#times_example_user",
    }),
    messageRowId({ key: "C100:1.000001" }),
    messageRowId({ key: "C100:1.000002" }),
    // 空欄の自分宛ての行は、同じメッセージの検索結果の行と id が重ならない
    triageRowId({ key: "C100:1.000001" }),
    triageRowId({ key: "C100:1.000002" }),
    warningRowId(0),
    warningRowId(12),
    STATUS_ROW_ID,
  ];
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 4), [
    "conv:C100",
    "conv:G200",
    "conv:G300",
    "person:U1",
  ]);
  assert.equal(messageRowId({ key: "C100:1.000001" }), "msg:C100:1.000001");
  assert.equal(triageRowId({ key: "C100:1.000001" }), "tome:C100:1.000001");
});

// ---- どの行にも置く共通の操作の並び ----------------------------------------------------

const THREE: CommonAction[] = ["swap", "reload-search", "reload-all"];
const STANDALONE_ROWS: StandaloneRow[] = [
  "search-status",
  "unresolved-filter",
  "empty",
];

test("共通の3つの操作（Shift+Tab・⌘R・⌘⇧R）は、どの行の並びでも、1つずつ残る", () => {
  for (const order of [
    COMMON_ACTIONS,
    ...STANDALONE_ROWS.map((row) => standaloneActions(row)),
  ]) {
    assert.deepEqual([...order].sort(), [...THREE].sort());
  }
  // 行に固有の操作があるときは、その操作のあとに、今までの順（入れ替え → 検索 → 一覧全体）で置く
  assert.deepEqual(COMMON_ACTIONS, ["swap", "reload-search", "reload-all"]);
});

test("共通の3つだけを持つ行の1番目（↵ で動く操作）は、並びの入れ替えでなく、その行が知らせている問題を直す取り直し", () => {
  // 検索が止まった・失敗した行：検索の取り直し（⌘R と同じ処理）
  assert.equal(standaloneActions("search-status")[0], "reload-search");
  // 相手が決まらない警告の行：新しいチャンネル・人が一覧に入れば相手が決まるので、一覧全体の取り直し（⌘⇧R と同じ処理）
  assert.equal(standaloneActions("unresolved-filter")[0], "reload-all");
  // 一覧が空のとき：段①と同じ、一覧全体の取り直し
  assert.equal(standaloneActions("empty")[0], "reload-all");
  // どの行でも、並びの入れ替え（Shift+Tab）が ↵ で動くことはない
  for (const row of STANDALONE_ROWS) {
    assert.notEqual(standaloneActions(row)[0], "swap", row);
  }
});

// ---- 操作のあとに先頭の行を選ぶ ------------------------------------------------------

const TEXT = "請求 in:#example_remind ";
// in:#名前 は、検索式では in:<#C…> になる
const QUERY = "請求 in:<#C1>";

const view = (overrides: Partial<SelectionView> = {}): SelectionView => ({
  text: TEXT,
  query: QUERY,
  search: { query: undefined, status: undefined },
  firstIds: {
    candidates: "cand:in:#a",
    conversations: "conv:C9",
    messages: "msg:C1:1.000003",
  },
  ...overrides,
});

const WAITING: SelectionView["search"] = {
  // 前の検索語の結果が残っている
  query: "請求",
  status: { kind: "ok", query: "請求" },
};
const CURRENT: SelectionView["search"] = {
  query: QUERY,
  status: { kind: "ok", query: QUERY },
};

const request = requestFirstRow(TEXT, undefined, false);

test("操作の予約：候補があれば候補、無ければ先に出るセクション（入れ替え中ならその順）", () => {
  assert.deepEqual(request, { text: TEXT, section: "messages" });
  assert.deepEqual(requestFirstRow("請求", undefined, false), {
    text: "請求",
    section: "conversations",
  });
  assert.deepEqual(requestFirstRow("請求", "messages", false), {
    text: "請求",
    section: "messages",
  });
  assert.deepEqual(requestFirstRow("in:op", undefined, true), {
    text: "in:op",
    section: "candidates",
  });
});

test("メッセージの先頭を選ぶのは、いまの検索語の結果が出てから。出るまでは予約を残して待つ", () => {
  const waiting = decideSelection(request, view({ search: WAITING }));
  assert.deepEqual(waiting, { selectedId: undefined, next: request });

  const done = decideSelection(request, view({ search: CURRENT }));
  assert.deepEqual(done, { selectedId: "msg:C1:1.000003", next: undefined });
});

test("使い終えた予約は、そのあと行が入れ替わっても、選び直さない（裏の取り直し・並べ替え・一覧の読み込みで選択が動かない）", () => {
  let pending = decideSelection(request, view({ search: WAITING })).next;
  assert.ok(pending);
  // 結果が出て、先頭を選んで、予約を使い終える
  const selected = decideSelection(pending, view({ search: CURRENT }));
  assert.equal(selected.selectedId, "msg:C1:1.000003");
  pending = selected.next;
  assert.equal(pending, undefined);

  // そのあと、同じ検索語のまま、先頭の行が別の行に入れ替わっても、何も返さない
  for (const messages of ["msg:C1:1.000009", "msg:C5:2.000001", undefined]) {
    assert.deepEqual(
      decideSelection(
        pending,
        view({
          search: CURRENT,
          firstIds: {
            candidates: undefined,
            conversations: "conv:C7",
            messages,
          },
        }),
      ),
      { selectedId: undefined, next: undefined },
    );
  }
});

test("予約が無いときは、行が入れ替わっても選ばない", () => {
  for (const firstIds of [
    { candidates: undefined, conversations: "conv:C1", messages: "msg:C1:1" },
    {
      candidates: "cand:in:#a",
      conversations: "conv:C2",
      messages: "msg:C2:2",
    },
  ]) {
    assert.deepEqual(
      decideSelection(undefined, view({ search: CURRENT, firstIds })),
      { selectedId: undefined, next: undefined },
    );
  }
});

test("待っている間に検索欄が変わったら、予約を捨てる", () => {
  assert.deepEqual(
    decideSelection(request, view({ text: `${TEXT}さらに`, search: CURRENT })),
    { selectedId: undefined, next: undefined },
  );
  // 結果が出ていても、検索欄が変わっていれば選ばない
  assert.deepEqual(
    decideSelection(request, view({ text: "別の語", search: CURRENT })),
    { selectedId: undefined, next: undefined },
  );
});

test("いまの検索語の検索が、失敗・停止・検索しない判断になったら、待っている予約を捨てる", () => {
  const statuses: SearchStatus[] = [
    { kind: "failed", query: QUERY, message: "An API error occurred: x" },
    {
      kind: "paused",
      query: QUERY,
      pause: { until: 1_759_560_030_000, cause: "rate_limited" },
    },
    { kind: "skipped", query: QUERY, reason: "too-short" },
    { kind: "skipped", query: QUERY, reason: "empty" },
  ];
  for (const status of statuses) {
    assert.deepEqual(
      decideSelection(request, view({ search: { query: undefined, status } })),
      { selectedId: undefined, next: undefined },
      status.kind,
    );
  }
});

test("前の検索語の失敗の記録は、いまの検索語の結果を待つ妨げにならない", () => {
  const staleFailure: SelectionView["search"] = {
    query: undefined,
    status: { kind: "failed", query: "請求", message: "前の検索の失敗" },
  };
  assert.deepEqual(decideSelection(request, view({ search: staleFailure })), {
    selectedId: undefined,
    next: request,
  });
});

test("いまの検索語かは、検索欄の文字ではなく、検索式で比べる（in:#名前 は検索式では in:<#C…>）", () => {
  // フックが返す検索式は in:<#C1>。検索欄の文字そのものと比べると、いつまでも一致しない
  const byRawText: SelectionView["search"] = {
    query: "請求 in:#example_remind",
    status: { kind: "ok", query: "請求 in:#example_remind" },
  };
  assert.deepEqual(decideSelection(request, view({ search: byRawText })), {
    selectedId: undefined,
    next: request,
  });
  assert.equal(
    decideSelection(request, view({ search: CURRENT })).selectedId,
    "msg:C1:1.000003",
  );
});

test("結果が出ても該当が無ければ、選ぶ行は無い（undefined）。予約は使い終える", () => {
  assert.deepEqual(
    decideSelection(
      request,
      view({
        search: CURRENT,
        firstIds: {
          candidates: undefined,
          conversations: "conv:C9",
          messages: undefined,
        },
      }),
    ),
    { selectedId: undefined, next: undefined },
  );
});

test("会話・候補の先頭は、検索の結果を待たず、すぐ選ぶ", () => {
  const conversationsFirst = requestFirstRow("請求", undefined, false);
  assert.deepEqual(
    decideSelection(
      conversationsFirst,
      view({ text: "請求", query: "請求", search: WAITING }),
    ),
    { selectedId: "conv:C9", next: undefined },
  );
  const candidatesFirst = requestFirstRow("in:op", undefined, true);
  assert.deepEqual(
    decideSelection(
      candidatesFirst,
      view({ text: "in:op", query: "", search: WAITING }),
    ),
    { selectedId: "cand:in:#a", next: undefined },
  );
  // 先頭の行が無いセクションでは、選ぶ行は無い
  assert.deepEqual(
    decideSelection(
      conversationsFirst,
      view({
        text: "請求",
        query: "請求",
        search: WAITING,
        firstIds: {
          candidates: undefined,
          conversations: undefined,
          messages: undefined,
        },
      }),
    ),
    { selectedId: undefined, next: undefined },
  );
});

// ---- 検索欄の文字を変えたことも、先頭の行を選ぶ操作に数える ------------------------------------

// 検索結果の記録。query は、結果を出した検索式
const resultsFor = (query: string): SelectionView["search"] => ({
  query,
  status: { kind: "ok", query },
});

test("絞り込み語のある文字を打ったあと（in:#example_remind のあとに good）は、メッセージの結果が出てから先頭のメッセージの行を選び、その前に会話の行は選ばない", () => {
  // in:#example_remind は検索式では in:<#C1>。いまの検索式は in:<#C1> good
  const text = "in:#example_remind good";
  const query = "in:<#C1> good";
  const typed = afterTextChange(text, undefined, false);
  assert.deepEqual(typed.request, { text, section: "messages" });

  // 打った直後：メッセージの結果は、前の検索語（in:<#C1>）のものしか無い。会話の行の id は返さず、予約を残して待つ
  const waiting = decideSelection(
    typed.request,
    view({ text, query, search: resultsFor("in:<#C1>") }),
  );
  assert.deepEqual(waiting, { selectedId: undefined, next: typed.request });

  // いまの検索語（good を足した検索式）の結果が出たら、先頭のメッセージの行を選ぶ
  assert.deepEqual(
    decideSelection(
      typed.request,
      view({ text, query, search: resultsFor(query) }),
    ),
    { selectedId: "msg:C1:1.000003", next: undefined },
  );
});

test("絞り込み語の無い文字を打ったときは、会話が先なので、結果を待たずに先頭の会話の行を選ぶ", () => {
  const typed = afterTextChange("請求", undefined, false);
  assert.deepEqual(typed.request, { text: "請求", section: "conversations" });
  assert.deepEqual(
    decideSelection(
      typed.request,
      view({ text: "請求", query: "請求", search: WAITING }),
    ),
    { selectedId: "conv:C9", next: undefined },
  );
});

test("入力中の絞り込み語に候補があるときは、いちばん上の候補を選ぶ", () => {
  const typed = afterTextChange("in:op", undefined, true);
  assert.deepEqual(typed.request, { text: "in:op", section: "candidates" });
  assert.deepEqual(
    decideSelection(
      typed.request,
      view({ text: "in:op", query: "", search: WAITING }),
    ),
    { selectedId: "cand:in:#a", next: undefined },
  );
  // 候補が無いときは、候補を選ばない（先に出るセクションの先頭）
  assert.equal(
    afterTextChange("in:zzz", undefined, false).request.section,
    "messages",
  );
});

test("待っている間に打ち直したら、予約を新しい文字の分に作り直す。前の文字の結果では選ばず、新しい文字の結果で選ぶ", () => {
  const first = afterTextChange("in:#example_remind good", undefined, false);
  const second = afterTextChange(
    "in:#example_remind goodbye",
    undefined,
    false,
  );
  assert.deepEqual(second.request, {
    text: "in:#example_remind goodbye",
    section: "messages",
  });

  const text = "in:#example_remind goodbye";
  const query = "in:<#C1> goodbye";
  // 前の文字（good）の結果が届いても、新しい予約では選ばない
  assert.deepEqual(
    decideSelection(
      second.request,
      view({ text, query, search: resultsFor("in:<#C1> good") }),
    ),
    { selectedId: undefined, next: second.request },
  );
  // 新しい文字の結果が届いたら選ぶ
  assert.deepEqual(
    decideSelection(
      second.request,
      view({ text, query, search: resultsFor(query) }),
    ),
    { selectedId: "msg:C1:1.000003", next: undefined },
  );
  // 前の文字の予約は、文字が変わったので捨てられる（二重に選ばない）
  assert.deepEqual(
    decideSelection(
      first.request,
      view({ text, query, search: resultsFor(query) }),
    ),
    { selectedId: undefined, next: undefined },
  );
});

test("予約に使う入れ替えの印は、文字を変えたあとのもの。検索欄を空にしたら解除してから予約を作り、文字が残っていれば保つ", () => {
  // メッセージを先にしたあと、検索欄を空にした：入れ替えは解除され、既定の順（会話が先）で予約する
  const cleared = afterTextChange("", "messages", false);
  assert.equal(cleared.override, undefined);
  assert.deepEqual(cleared.request, { text: "", section: "triage" });
  // 文字が残っているあいだは、入れ替えを保ち、その順で予約する
  const kept = afterTextChange("請求書", "messages", false);
  assert.equal(kept.override, "messages");
  assert.deepEqual(kept.request, { text: "請求書", section: "messages" });
  // 入れ替えが無ければ、そのまま
  assert.equal(afterTextChange("請求", undefined, false).override, undefined);
});

test("Tab・⌘F・候補の確定は、文字を変えた操作と同じ予約になる（足した文字の末尾は空白なので、候補は無い）", () => {
  const added = textWithFilter("請求", "in:#example_remind", "message");
  assert.equal(added, "請求 in:#example_remind ");
  assert.deepEqual(afterTextChange(added, undefined, false).request, {
    text: added,
    section: "messages",
  });
  // 入れ替えの印があっても、文字を変えたあとの印で予約する
  const swapped = toggleOverride("請求", undefined);
  assert.equal(swapped, "messages");
  assert.deepEqual(afterTextChange(added, swapped, false), {
    override: "messages",
    request: { text: added, section: "messages" },
  });
});

// ---- 空欄の自分宛て：先頭の行を選ぶ -----------------------------------------------------

// 検索欄が空のときの、各セクションの先頭の行。メッセージの検索はしていない（検索式が空）
const emptyView = (firstIds: SelectionView["firstIds"]): SelectionView =>
  view({
    text: "",
    query: "",
    search: { query: undefined, status: undefined },
    firstIds,
  });

const EMPTY_IDS: SelectionView["firstIds"] = {
  candidates: undefined,
  conversations: "conv:C9",
  messages: undefined,
  triage: "tome:C1:1.000005",
};

test("空欄の自分宛ては、検索の結果を待たず、すぐ先頭の行を選ぶ。Shift+Tab で会話が先なら会話の先頭", () => {
  const toMe = requestFirstRow("", undefined, false);
  assert.deepEqual(toMe, { text: "", section: "triage" });
  assert.deepEqual(decideSelection(toMe, emptyView(EMPTY_IDS)), {
    selectedId: "tome:C1:1.000005",
    next: undefined,
  });

  const swapped = requestFirstRow("", "conversations", false);
  assert.deepEqual(swapped, { text: "", section: "conversations" });
  assert.deepEqual(decideSelection(swapped, emptyView(EMPTY_IDS)), {
    selectedId: "conv:C9",
    next: undefined,
  });

  // 自分宛ての行が無ければ、選ぶ行は無い（予約は使い終える）
  assert.deepEqual(
    decideSelection(toMe, emptyView({ ...EMPTY_IDS, triage: undefined })),
    { selectedId: undefined, next: undefined },
  );
});

test("自分宛ての取り直し・既読位置・未読タグで、先頭の自分宛ての行が入れ替わっても、予約が無ければ選び直さない", () => {
  // 先頭を選んで、予約を使い終える
  const used = decideSelection(
    requestFirstRow("", undefined, false),
    emptyView(EMPTY_IDS),
  ).next;
  assert.equal(used, undefined);
  // そのあと、先頭の行が別の行に入れ替わっても（会話の先頭が変わっても）、何も返さない
  for (const triage of ["tome:C1:1.000009", "tome:C5:2.000001", undefined]) {
    assert.deepEqual(
      decideSelection(
        used,
        emptyView({ ...EMPTY_IDS, triage, conversations: "conv:C7" }),
      ),
      { selectedId: undefined, next: undefined },
    );
  }
});

test("検索欄を空にしたら、自分宛ての先頭を選ぶ。メッセージの検索結果が残っていても、会話の行でもない", () => {
  // メッセージを先にした状態（in: の検索中）から、検索欄を空にした
  const cleared = afterTextChange("", "messages", false, "in:#a 請求");
  assert.equal(cleared.override, undefined);
  assert.deepEqual(cleared.request, { text: "", section: "triage" });
  assert.deepEqual(
    decideSelection(
      cleared.request,
      view({
        text: "",
        query: "",
        // 前の検索語の結果が残っている
        search: {
          query: "in:<#C1> 請求",
          status: { kind: "ok", query: "in:<#C1> 請求" },
        },
        firstIds: EMPTY_IDS,
      }),
    ),
    { selectedId: "tome:C1:1.000005", next: undefined },
  );
});

test("空欄から打ち始めたり、空欄の行で Tab を押したりしたとき、空欄での入れ替えを持ち越さずに予約を作る", () => {
  // 空欄で Shift+Tab を押して、会話を先にした
  const swapped = toggleOverride("", undefined);
  assert.equal(swapped, "conversations");

  // in: を打ち始めた：メッセージが先に戻り、メッセージの結果が出てから先頭のメッセージの行を選ぶ
  const typed = afterTextChange("in:#example_remind ", swapped, false, "");
  assert.equal(typed.override, undefined);
  assert.deepEqual(typed.request, {
    text: "in:#example_remind ",
    section: "messages",
  });

  // 空欄の一覧の行（自分宛てのメッセージ）で Tab を押して、会話で絞った：同じ
  const added = textWithFilter("", "in:#example_remind", "message");
  assert.equal(added, "in:#example_remind ");
  assert.deepEqual(afterTextChange(added, swapped, false, "").request, {
    text: added,
    section: "messages",
  });

  // 文字を打ち始めただけ（絞り込み語なし）なら、会話が先
  assert.deepEqual(afterTextChange("請", swapped, false, "").request, {
    text: "請",
    section: "conversations",
  });
});
