import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLibraryMutation,
  emptyLibrary,
  initializeLibrary,
  parseLibraryDocument,
  type LibraryDocument,
} from "./model.ts";
const identity = { teamId: "T1", userId: "U1" };
test("お気に入りと複数所属は独立し、元のデータを変更しない", () => {
  const original = emptyLibrary(identity);
  let library = applyLibraryMutation(
    original,
    { kind: "create-section", name: " 開発 " },
    () => "s1",
  );
  library = applyLibraryMutation(
    library,
    { kind: "create-section", name: "今週" },
    () => "s2",
  );
  library = applyLibraryMutation(library, {
    kind: "favorite",
    channelId: "C1",
    favorite: true,
  });
  library = applyLibraryMutation(library, {
    kind: "set-channel-sections",
    channelId: "C1",
    sectionIds: ["s1", "s2"],
  });
  library = applyLibraryMutation(library, {
    kind: "favorite",
    channelId: "C1",
    favorite: false,
  });
  assert.deepEqual(
    library.sections.map((s) => s.channelIds),
    [["C1"], ["C1"]],
  );
  library = applyLibraryMutation(library, {
    kind: "favorite",
    channelId: "C1",
    favorite: true,
  });
  library = applyLibraryMutation(library, {
    kind: "delete-section",
    sectionId: "s1",
  });
  assert.deepEqual(library.favoriteChannelIds, ["C1"]);
  assert.equal(library.sections[0].id, "s2");
  assert.equal(original.sections.length, 0);
});
test("空白名・同名・古い所属先・人物IDを拒否しチャンネルIDを重複除去", () => {
  const library = {
    ...emptyLibrary(identity),
    sections: [{ id: "s1", name: "開発", channelIds: [] }],
  };
  assert.throws(() =>
    applyLibraryMutation(library, { kind: "create-section", name: "  " }),
  );
  assert.throws(() =>
    applyLibraryMutation(library, { kind: "create-section", name: " 開発 " }),
  );
  assert.throws(() =>
    applyLibraryMutation(library, {
      kind: "set-channel-sections",
      channelId: "C1",
      sectionIds: ["deleted"],
    }),
  );
  assert.throws(() =>
    applyLibraryMutation(library, {
      kind: "favorite",
      channelId: "U1",
      favorite: true,
    }),
  );
  assert.deepEqual(
    applyLibraryMutation(library, {
      kind: "set-section-channels",
      sectionId: "s1",
      channelIds: ["C1", "C1"],
    }).sections[0].channelIds,
    ["C1"],
  );
});
test("未完了ディレクトリは移行せず、旧人物・MPIM・未解決IDを保持して別accountへの再配布を防ぐ", () => {
  const document: LibraryDocument = {
    version: 1,
    accounts: {},
    legacyClaims: {},
  };
  const directory = [
    { id: "C1", name: "public", type: "public" as const },
    { id: "G1", name: "private", type: "private" as const },
    { id: "G2", name: "mpim", type: "mpim" as const },
  ];
  const legacy = ["C1", "G1", "G2", "U1", "CUNKNOWN"];
  assert.equal(
    initializeLibrary(document, identity, directory, false, legacy),
    false,
  );
  assert.deepEqual(document.accounts, {});
  assert.equal(
    initializeLibrary(document, identity, directory, true, legacy),
    true,
  );
  assert.deepEqual(document.accounts["T1-U1"].favoriteChannelIds, ["C1", "G1"]);
  assert.equal(
    initializeLibrary(
      document,
      { teamId: "T2", userId: "U2" },
      [...directory, { id: "CUNKNOWN", name: "later", type: "public" }],
      true,
      legacy,
    ),
    true,
  );
  assert.deepEqual(document.accounts["T2-U2"].favoriteChannelIds, ["CUNKNOWN"]);
  assert.deepEqual(legacy, ["C1", "G1", "G2", "U1", "CUNKNOWN"]);
});
test("不正なアカウント・孤立した移行記録・重複セクションを破損として拒否", () => {
  assert.throws(() =>
    parseLibraryDocument({
      version: 1,
      accounts: { "T2-U2": emptyLibrary(identity) },
      legacyClaims: {},
    }),
  );
  assert.throws(() =>
    parseLibraryDocument({
      version: 1,
      accounts: {},
      legacyClaims: { C1: "T1-U1" },
    }),
  );
  assert.throws(() =>
    parseLibraryDocument({
      version: 1,
      accounts: {
        "T1-U1": {
          ...emptyLibrary(identity),
          sections: [
            { id: "s1", name: "a", channelIds: [] },
            { id: "s2", name: "a", channelIds: [] },
          ],
        },
      },
      legacyClaims: {},
    }),
  );
});
