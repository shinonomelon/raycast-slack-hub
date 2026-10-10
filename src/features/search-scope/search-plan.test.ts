import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveScope,
  scopeFingerprint,
  validateScopeSelection,
  type SearchScope,
} from "./model.ts";
import {
  createMessageSearchPlan,
  createReplySearchPlan,
} from "./search-plan.ts";
import type { FilterSource } from "../search/query.ts";
const library = {
  version: 1 as const,
  teamId: "T1",
  userId: "U1",
  favoriteChannelIds: ["C2", "C1", "C2", "C3"],
  sections: [{ id: "s", name: "開発", channelIds: ["C1", "C2"] }],
};
const conversations = [
  { id: "C1", name: "one", type: "public" as const },
  { id: "C2", name: "two", type: "private" as const },
];
const sources: FilterSource[] = [
  { id: "C1", kind: "channel", title: "one", token: "#one", keywords: ["one"] },
  { id: "C2", kind: "private", title: "two", token: "#two", keywords: ["two"] },
  {
    id: "U2",
    kind: "person",
    title: "alice",
    token: "@alice",
    keywords: ["alice"],
  },
];
const scope = resolveScope(
  { range: { kind: "section", sectionId: "s" }, senderId: "U2" },
  library,
  conversations,
).resolved;
const plan = (text: string) =>
  createMessageSearchPlan({ text, scope, sources, selfId: "U1" });
test("範囲は重複除去し未解決IDを残す", () => {
  const result = resolveScope(
    { range: { kind: "favorites" } },
    library,
    conversations,
  );
  assert.deepEqual(result.resolved.channelIds, ["C1", "C2"]);
  assert.deepEqual(result.unresolvedChannelIds, ["C3"]);
});
test("空範囲と全体、名前変更と所属変更を区別する", () => {
  assert.notEqual(scopeFingerprint([]), scopeFingerprint("all"));
  assert.equal(
    scopeFingerprint(["C2", "C1", "C1"]),
    scopeFingerprint(["C1", "C2"]),
  );
  const selection: SearchScope = { range: { kind: "section", sectionId: "s" } };
  const before = resolveScope(selection, library, conversations).resolved
    .fingerprint;
  assert.equal(
    resolveScope(
      selection,
      { ...library, sections: [{ ...library.sections[0], name: "別名" }] },
      conversations,
    ).resolved.fingerprint,
    before,
  );
  assert.notEqual(
    resolveScope(
      selection,
      {
        ...library,
        sections: [{ ...library.sections[0], channelIds: ["C1"] }],
      },
      conversations,
    ).resolved.fingerprint,
    before,
  );
  assert.equal(
    resolveScope(
      { range: { kind: "section", sectionId: "missing" } },
      library,
      conversations,
    ).missingSection,
    true,
  );
});
test("通常検索は自由語とチャンネルと投稿者をANDで結合する", () => {
  assert.deepEqual(plan("議事録").queries, [
    "議事録 in:<#C1> from:<@U2>",
    "議事録 in:<#C2> from:<@U2>",
  ]);
  assert.equal(plan("").canSearch, true);
  assert.deepEqual(plan("in:#one from:@alice ").queries, [
    "in:<#C1> from:<@U2>",
  ]);
  assert.equal(plan("in:<#C3> ").empty, true);
  assert.equal(plan("from:<@U3> ").empty, true);
  assert.equal(plan("in:@alice ").empty, true);
});
test("否定条件を保持し複数、括弧、未確定条件は送らない", () => {
  assert.match(
    plan("-in:#one -from:@alice ").queries[0],
    /^-in:<#C1> -from:<@U2>/,
  );
  for (const text of [
    "in:#one in:#two ",
    "(in:#one OR in:#two)",
    "in:#unknown ",
    "in: ",
    "from: ",
    "from:@alice",
  ]) {
    assert.equal(plan(text).canSearch, false, text);
    assert.ok(plan(text).conflicts.length, text);
  }
});
test("条件なしは既存resolverと1文字ガードを維持する", () => {
  const scope = resolveScope(
    { range: { kind: "all" } },
    library,
    conversations,
  ).resolved;
  assert.deepEqual(
    createMessageSearchPlan({
      text: "from:@alice ",
      scope,
      sources,
      selfId: "U1",
    }).queries,
    ["from:<@U2>"],
  );
  assert.equal(
    createMessageSearchPlan({ text: "a", scope, sources, selfId: "U1" })
      .canSearch,
    false,
  );
});
test("返信待ちの限定範囲ではDMを作らず全体の両検索に投稿者を付ける", () => {
  assert.deepEqual(createReplySearchPlan(scope, "U1", "2026-10-01"), [
    "<@U1> in:<#C1> after:2026-10-01 from:<@U2>",
    "<@U1> in:<#C2> after:2026-10-01 from:<@U2>",
  ]);
  assert.deepEqual(
    createReplySearchPlan({ ...scope, channelIds: "all" }, "U1", "2026-10-01"),
    ["<@U1> after:2026-10-01 from:<@U2>", "to:me after:2026-10-01 from:<@U2>"],
  );
  assert.deepEqual(
    createReplySearchPlan({ ...scope, channelIds: [] }, "U1", "2026-10-01"),
    [],
  );
  assert.throws(() =>
    createReplySearchPlan(
      { ...scope, senderId: "U2 other" },
      "U1",
      "2026-10-01",
    ),
  );
});

test("構造化条件とOR/括弧の自由語は競合し引用内は維持する", () => {
  for (const text of ["foo OR bar", "(foo bar)", "-in:#one OR foo"])
    assert.equal(plan(text).canSearch, false, text);
  assert.equal(plan('"foo OR bar"').canSearch, true);
  assert.equal(plan('"(foo)"').canSearch, true);
  assert.match(scopeFingerprint(["C1"], "U2"), /^[a-f0-9]{64}$/);
});

test("構造化条件でorを含む確定フィルター値は検索でき、独立ORは引き続き拒否する", () => {
  const filterSources: FilterSource[] = [
    ...sources,
    {
      id: "C1",
      kind: "channel",
      title: "foo-or-bar",
      token: "#foo-or-bar",
      keywords: ["foo-or-bar"],
    },
    { id: "U2", kind: "person", title: "or", token: "@or", keywords: ["or"] },
  ];
  const search = (text: string) =>
    createMessageSearchPlan({
      text,
      scope,
      sources: filterSources,
      selfId: "U1",
    });
  assert.deepEqual(search("in:#foo-or-bar ").queries, ["in:<#C1> from:<@U2>"]);
  assert.deepEqual(search("from:@or ").queries, [
    "in:<#C1> from:<@U2>",
    "in:<#C2> from:<@U2>",
  ]);
  assert.equal(search("in:#foo-or-bar OR from:@or ").canSearch, false);
  assert.equal(search("from:@or or foo ").canSearch, false);
  assert.equal(search('"foo OR bar" from:@or ').canSearch, true);
});

test("条件フォームは新セクションを受け入れ削除済み選択を拒否する", () => {
  const selected: SearchScope = {
    range: { kind: "section", sectionId: "new" },
  };
  assert.ok(validateScopeSelection(selected, library, conversations));
  const updated = {
    ...library,
    sections: [
      ...library.sections,
      { id: "new", name: "追加", channelIds: [] },
    ],
  };
  assert.equal(
    validateScopeSelection(selected, updated, conversations),
    undefined,
  );
  assert.ok(
    validateScopeSelection(
      selected,
      { ...updated, sections: [] },
      conversations,
    ),
  );
  assert.ok(
    validateScopeSelection(
      { range: { kind: "all" } },
      library,
      conversations,
      true,
    ),
  );
  assert.equal(
    validateScopeSelection(
      { range: { kind: "all" }, senderId: "U2" },
      library,
      conversations,
      true,
    ),
    undefined,
  );
});
