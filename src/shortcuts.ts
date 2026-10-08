// 一覧の行に置く操作のショートカット。行の種類（会話・人・メッセージ・候補）をまたいで同じキーを使うので、1か所に置く。
// 型だけを読むので、@raycast/api を読み込まない
import type { Keyboard } from "@raycast/api";

// 行で Tab を押すと、その行の会話・人で絞り込む（検索欄に in:・from: を足す）。
// 文字が空のときの Tab も届くことを、使い捨ての拡張で確かめた（2026年10月4日）。予備に ⌘F を置く
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
// メッセージの行の ↵ はサイドバーの出し入れ、⌘↵ は Slack で開く操作に使うので、返信には修飾キーを足したこのキーを使う
export const REPLY_SHORTCUT: Keyboard.Shortcut = {
  modifiers: ["cmd", "shift"],
  key: "return",
};
