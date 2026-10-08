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

test("返信は ⌘⇧↵（Return キー）。メッセージの行の ↵（サイドバー）・⌘↵（Slack で開く）とは別のキー", () => {
  assert.deepEqual(shortcuts.REPLY_SHORTCUT, {
    modifiers: ["cmd", "shift"],
    key: "return",
  });
  assert.equal(keyOf(shortcuts.REPLY_SHORTCUT), "cmd+shift+return");
});

// 次のキーとの重なりは見ていない：Keyboard.Shortcut.Common のキー（⌘Y・⌘O・⌘⇧C など）、slack-hub.tsx の ⌘D など他のファイルで付けているキー、
// 1番目・2番目の操作に自動で付く ↵・⌘↵。⌘Y を同じパネルに1つしか置かないことも見ていない（message-row.tsx と slack-hub.tsx で、置く条件が互いに逆であることで保っている）
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
