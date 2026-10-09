// 一覧の行に置く操作のショートカット。行の種類（会話・人・メッセージ・候補）をまたいで同じキーを使うので、1か所に置く。
// 型だけを読むので、@raycast/api を読み込まない
import type { Keyboard } from "@raycast/api";

// 行で Tab を押すと、その行の会話・人で絞り込む（検索欄に in:・from: を足す）。
// 拡張内で定義するキー。予備に⌘Fを置く。Raycast本体のキー設定は読み取らない。
export const FILTER_SHORTCUT: Keyboard.Shortcut = {
  modifiers: [],
  key: "tab",
};
export const FILTER_SHORTCUT_ALT: Keyboard.Shortcut = {
  modifiers: ["cmd"],
  key: "f",
};

// Shift+Tab で、会話とメッセージの順を入れ替える
export const SWAP_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["shift"],
  key: "tab",
};

// ⌘⇧R で、会話と人の一覧をすべて取り直す（⌘R は、検索の取り直しに使う）
export const RELOAD_ALL_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd", "shift"],
  key: "r",
};

// ⌘⇧D で、メッセージの行に「対応済み」の印を付け外しする
export const HANDLED_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd", "shift"],
  key: "d",
};

// ⌘⇧↵ で、メッセージの行のスレッドに返信する。
// 一覧の ↵ は Slack で開く操作、⌘↵ は詳細の出し入れに使うので、返信は別のキーにする
export const REPLY_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd", "shift"],
  key: "return",
};

// ⌘↵ は一覧の詳細を出す・閉じる。2番目のActionの自動割当とそろえる。
export const DETAILS_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd"],
  key: "return",
};
// ⌘N で選択した会話・人への投稿フォームを開く。
export const WRITE_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd"],
  key: "n",
};
