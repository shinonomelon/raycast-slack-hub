import assert from "node:assert/strict";
import { test } from "node:test";
import { rowDetail, escapeDetail } from "./row-detail.ts";
import type { Row } from "../../slack/items.ts";
const row: Row = {
  id: "C1",
  title: "general",
  kind: "channel",
  aliases: [],
  keywords: [],
};
test("会話の詳細は取得済みの名前・種別・別名を表示し、人の情報を推測しない", () => {
  for (const [kind, label] of [
    ["channel", "公開チャンネル"],
    ["private", "非公開チャンネル"],
    ["group", "グループDM"],
  ] as const) {
    const result = rowDetail({ ...row, kind, aliases: ["開発"] });
    assert.ok(result.includes(label));
    assert.ok(result.includes("開発"));
    assert.ok(!result.includes("ハンドル"));
  }
});
test("人の詳細はハンドル・実名・役職を表示し、空値を省く", () => {
  const person = {
    id: "U1",
    displayName: "名前",
    handle: "user",
    realName: "実名",
    title: "役職名",
    isBot: false,
  };
  const result = rowDetail({ ...row, kind: "person" }, person);
  for (const value of ["@user", "実名", "役職名"])
    assert.ok(result.includes(value));
  assert.ok(
    !rowDetail(
      { ...row, kind: "person" },
      { ...person, handle: "", realName: "", title: "" },
    ).includes("ハンドル"),
  );
});
test("詳細の値のリンク・見出し・HTML記号・改行を文字として扱う", () => {
  assert.equal(
    escapeDetail("[x](url)\n# <b>*a*"),
    "\\[x\\]\\(url\\) \\# \\<b\\>\\*a\\*",
  );
  assert.ok(
    rowDetail({ ...row, title: "[x](url)", aliases: ["*a*"] }).includes(
      "\\*a\\*",
    ),
  );
});
