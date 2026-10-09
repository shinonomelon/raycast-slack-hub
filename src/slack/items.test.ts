import assert from "node:assert/strict";
import { test } from "node:test";
import { toFilterSources, toItems } from "./items.ts";
import {
  filterByMembership,
  orderItems,
  rankItems,
} from "../features/search/search.ts";
import type { Conversation, Person, Prefs } from "../shared/types.ts";

const prefs: Prefs = {
  favorites: [],
  aliases: {},
  dictionary: [],
  membership: "all",
};

const person = (
  id: string,
  handle: string,
  displayName: string,
  realName = displayName,
): Person => ({ id, handle, displayName, realName, title: "", isBot: false });

const channel = (id: string, name: string): Conversation => ({
  id,
  name,
  type: "public",
});

const people = [
  person("U1", "sato_y", "佐藤", "佐藤 由"),
  person("U2", "jones_f", "山田"),
  person("U3", "asobi_taro", "遊 太郎"),
];

const conversations: Conversation[] = [
  channel("C1", "example_asobiba"),
  // 名前が短いので、並べ替える前は C1 より前に来る。単語の先頭ではなく途中に当たるので、一致は C1 より弱い
  channel("C2", "ops_xasobiba"),
  { id: "G1", name: "times_example_user", type: "private" },
  {
    id: "M1",
    name: "mpdm-example_user--sato_y--jones_f-1",
    type: "mpim",
  },
];

// 自分のハンドル（auth.test の user と Previous Handles）。グループDMの名前から自分を除く
const SELF_HANDLES = ["example_user", "example_old"];

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

test("asobiba と打つと #example_asobiba が先頭に出る。弱い一致の行は後ろに、当たらない行は外れる", () => {
  const rows = toItems(conversations, people, prefs, SELF_HANDLES);
  // 並べ替える前は、名前の短い C2 のほうが前にいる（このテストが一致の強さで並べ替えることを確かめるため）
  assert.ok(ids(rows).indexOf("C2") < ids(rows).indexOf("C1"));

  const shown = rankItems(rows, "asobiba");
  assert.deepEqual(ids(shown), ["C1", "C2"]);
  assert.equal(shown[0].title, "example_asobiba");
});

test("同じ強さの一致なら、お気に入りが名前の長さに関わらず先に出る", () => {
  const rows = toItems(
    [channel("C5", "asobiba_a"), channel("C6", "asobiba_long_channel")],
    [],
    prefs,
    SELF_HANDLES,
  );
  assert.deepEqual(ids(rankItems(rows, "asobiba")), ["C5", "C6"]);
  assert.deepEqual(
    ids(rankItems(orderItems(rows, new Set(["C6"])), "asobiba")),
    ["C6", "C5"],
  );
});

test("別名を付けると、その語で打ったときにその会話が出る", () => {
  const withAlias: Prefs = { ...prefs, aliases: { G1: ["分報"] } };
  assert.deepEqual(
    ids(rankItems(toItems(conversations, people, prefs, SELF_HANDLES), "分報")),
    [],
  );
  const rows = toItems(conversations, people, withAlias, SELF_HANDLES);
  assert.deepEqual(ids(rankItems(rows, "分報")), ["G1"]);
  // 一覧にタグで出す別名は、行に持たせる
  assert.deepEqual(rows.find((r) => r.id === "G1")?.aliases, ["分報"]);
});

test("辞書で置き換えた名前でも引ける。規則に当たらない名前には照合語を足さない", () => {
  const list = [
    channel("C7", "project_資料管理課_共同作業メンバー"),
    channel("C8", "random"),
  ];
  const withDict: Prefs = {
    ...prefs,
    dictionary: [{ from: "資料管理", to: "auto" }],
  };
  assert.deepEqual(
    ids(rankItems(toItems(list, [], prefs, SELF_HANDLES), "project_auto")),
    [],
  );
  const rows = toItems(list, [], withDict, SELF_HANDLES);
  assert.deepEqual(ids(rankItems(rows, "project_auto")), ["C7"]);
  assert.deepEqual(rows.find((r) => r.id === "C8")?.keywords, ["random"]);
});

test("グループDMは自分を除いた参加者の表示名が名前になり、自分のハンドルでは当たらない", () => {
  const rows = toItems(conversations, people, prefs, SELF_HANDLES);
  assert.equal(rows.find((r) => r.id === "M1")?.title, "佐藤, 山田");
  assert.equal(rows.find((r) => r.id === "M1")?.kind, "group");
  // 参加者のハンドルでは当たる。自分のハンドルでは当たらない
  assert.ok(ids(rankItems(rows, "jones_f")).includes("M1"));
  assert.ok(!ids(rankItems(rows, "example_user")).includes("M1"));
});

test("グループDMの名前から除く自分のハンドルは、渡された一覧で決まる（auth.test の user と Previous Handles）。一覧に無い古いハンドルは、除かれずに残る", () => {
  // 古いハンドル（example_old）を知らないと、自分が参加者の1人として残る
  const onlyCurrent = toItems(conversations, people, prefs, ["example_user"]);
  assert.equal(onlyCurrent.find((r) => r.id === "M1")?.title, "佐藤, 山田");
  const oldName = [
    ...conversations,
    {
      id: "M2",
      name: "mpdm-example_old--sato_y--jones_f-1",
      type: "mpim" as const,
    },
  ];
  assert.equal(
    toItems(oldName, people, prefs, ["example_user"]).find((r) => r.id === "M2")
      ?.title,
    "example_old, 佐藤, 山田",
  );
  // Previous Handles に入れれば、古いグループDMの名前からも除かれる
  assert.equal(
    toItems(oldName, people, prefs, ["example_user", "example_old"]).find(
      (r) => r.id === "M2",
    )?.title,
    "佐藤, 山田",
  );
  // 自分のハンドルを渡さなければ、除かない
  assert.equal(
    toItems(conversations, people, prefs, []).find((r) => r.id === "M1")?.title,
    "example_user, 佐藤, 山田",
  );
});

test("人の行は表示名を題に、本名とハンドルを副題にする", () => {
  const rows = toItems(
    [],
    [person("U9", "example_user", "田中", "田中 太郎")],
    prefs,
    SELF_HANDLES,
  );
  assert.equal(rows[0].kind, "person");
  assert.equal(rows[0].title, "田中");
  assert.equal(rows[0].subtitle, "田中 太郎  @example_user");
  assert.ok(rows[0].keywords.includes("example_user"));
  assert.ok(rows[0].keywords.includes("田中 太郎"));

  // 本名と表示名が同じなら、副題はハンドルだけ
  const same = toItems(
    [],
    [person("U8", "sato_y", "佐藤")],
    prefs,
    SELF_HANDLES,
  );
  assert.equal(same[0].subtitle, "@sato_y");
});

test("検索語が無いときは、名前の短い順に並ぶ", () => {
  const rows = toItems(
    [channel("C1", "long_channel_name"), channel("C2", "short")],
    [person("U1", "mid_h", "mid_name")],
    prefs,
    SELF_HANDLES,
  );
  assert.deepEqual(ids(rows), ["C2", "U1", "C1"]);
});

test("参加中の絞り込みで、参加していないチャンネルが外れる（人は外れ、未参加では参加していないチャンネルだけが残る）", () => {
  const rows = toItems(conversations, people, prefs, SELF_HANDLES);
  const joined = new Set(["C1"]);
  assert.deepEqual(ids(filterByMembership(rows, "joined", joined)).sort(), [
    "C1",
    "G1",
    "M1",
  ]);
  assert.deepEqual(ids(filterByMembership(rows, "notJoined", joined)), ["C2"]);
  assert.equal(filterByMembership(rows, "all", joined).length, rows.length);
});

test("検索欄の候補は、チャンネルを #正式名、人を @ハンドル にし、グループDMは入れない", () => {
  const sources = toFilterSources(
    toItems(
      [
        channel("C1", "project_資料管理課_共同作業メンバー"),
        { id: "G1", name: "example_remind", type: "private" },
        { id: "M1", name: "mpdm-example_user--sato_y-1", type: "mpim" },
      ],
      [person("U1", "sato_y", "佐藤", "佐藤 由")],
      prefs,
      SELF_HANDLES,
    ),
    [person("U1", "sato_y", "佐藤", "佐藤 由")],
  );
  assert.deepEqual(sources.map((s) => [s.id, s.token]).sort(), [
    ["C1", "#project_資料管理課_共同作業メンバー"],
    ["G1", "#example_remind"],
    ["U1", "@sato_y"],
  ]);
});

test("検索欄の候補の元の並びは渡した行の並びのまま。ハンドルが分からない人は入れない", () => {
  const rows = toItems(
    [channel("C1", "bbb"), channel("C2", "aaa")],
    [person("U1", "sato_y", "佐藤")],
    prefs,
    SELF_HANDLES,
  );
  // 渡した並びを入れ替えても、その並びのまま候補元になる（お気に入り・最近開いた順の並びは呼び出し側が決める）
  const reversed = [...rows].reverse();
  assert.deepEqual(
    toFilterSources(reversed, [person("U1", "sato_y", "佐藤")]).map(
      (s) => s.id,
    ),
    reversed.map((r) => r.id),
  );
  // 人の一覧にハンドルが無い行は、候補にできない
  assert.deepEqual(
    toFilterSources(rows, []).map((s) => s.id),
    ["C2", "C1"],
  );
});
