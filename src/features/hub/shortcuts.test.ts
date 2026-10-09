import assert from "node:assert/strict";
import { test } from "node:test";
import type { Keyboard } from "@raycast/api";
import * as shortcuts from "./shortcuts.ts";

// 修飾キーの順に関わらず同じになる、キーの表記（例：cmd+shift+return）
function keyOf(shortcut: Keyboard.Shortcut): string {
  if (!("modifiers" in shortcut)) {
    throw new Error("OS ごとに分けたショートカットは、この一覧では使わない");
  }
  return [...[...shortcut.modifiers].sort(), shortcut.key].join("+");
}

test("返信は ⌘⇧↵（Return キー）。メッセージの行の ↵（Slack で開く）・⌘↵（詳細）とは別のキー", () => {
  assert.deepEqual(shortcuts.REPLY_SHORTCUT, {
    modifiers: ["cmd", "shift"],
    key: "return",
  });
  assert.equal(keyOf(shortcuts.REPLY_SHORTCUT), "cmd+shift+return");
});

// 標準キーと他画面のキーは対象外。自動割当の先頭2操作は実画面でも検証する。
test("shortcuts.ts が出すショートカットどうしは、どれも別のキー", () => {
  const owners = new Map<string, string>();
  for (const [name, shortcut] of Object.entries(shortcuts)) {
    const key = keyOf(shortcut);
    assert.equal(
      owners.get(key),
      undefined,
      `${name} が ${owners.get(key)} と重なる`,
    );
    owners.set(key, name);
  }
  // 何も数えずに通ってしまわないよう、返信のキーがこの検査に入っていることを確かめる
  assert.equal(owners.get("cmd+shift+return"), "REPLY_SHORTCUT");
});

test("詳細は2番目の自動キーと一致し、Writeは自動Returnキーと重ならない", () => {
  assert.equal(keyOf(shortcuts.DETAILS_SHORTCUT), "cmd+return");
  assert.equal(keyOf(shortcuts.WRITE_SHORTCUT), "cmd+n");
  assert.notEqual(keyOf(shortcuts.WRITE_SHORTCUT), "return");
  assert.notEqual(
    keyOf(shortcuts.WRITE_SHORTCUT),
    keyOf(shortcuts.DETAILS_SHORTCUT),
  );
});
