import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, toPlain, type NameLookup } from "./mrkdwn.ts";

const names: NameLookup = {
  user: (id) => ({ U1: "田中 太郎" })[id],
  channel: (id) => ({ C1: "general" })[id],
};

test("メンションとチャンネルを表示名にする。分からなければラベルか ID を出す", () => {
  assert.equal(toPlain("<@U1> 見て", names), "@田中 太郎 見て");
  assert.equal(toPlain("<@U9|alice> 見て", names), "@alice 見て");
  assert.equal(toPlain("<@U9>", names), "@U9");
  assert.equal(
    toPlain("<#C1|old-name> と <#C1>", names),
    "#general と #general",
  );
  assert.equal(toPlain("<#C9|random>", names), "#random");
});

test("@here・ユーザーグループ・URL・メールを読める形にする", () => {
  assert.equal(toPlain("<!here> <!channel>", names), "@here @channel");
  assert.equal(toPlain("<!subteam^S1|@dev> 確認", names), "@dev 確認");
  assert.equal(
    toPlain("<https://a.example/x|資料> と <https://b.example>", names),
    "資料 と https://b.example",
  );
  assert.equal(
    toPlain("<mailto:a@example.com|a@example.com>", names),
    "a@example.com",
  );
  assert.equal(toPlain("<mailto:a@example.com>", names), "a@example.com");
});

test("文字参照を戻す。リテラルの &lt;@U1&gt; はメンションに変えず、&amp;lt; は二重に戻さない", () => {
  assert.equal(toPlain("a &amp; b", names), "a & b");
  assert.equal(toPlain("&lt;@U1&gt;", names), "<@U1>");
  assert.equal(toPlain("&amp;lt;", names), "&lt;");
});

test("見出しは改行と連続する空白をまとめ、長ければ切る", () => {
  assert.equal(toPlain("1行目\n\n2行目   3", names), "1行目 2行目 3");
  assert.equal(toPlain("あいうえおかきくけこ", names, 5), "あいうえお…");
});

test("詳細は Markdown にする（リンク・太字・打ち消し、改行は残す）", () => {
  assert.equal(
    toMarkdown("*重要* です\n<https://a.example|資料> ~古い~", names),
    "**重要** です\n[資料](https://a.example) ~~古い~~",
  );
  // 掛け算のような * は太字にしない
  assert.equal(toMarkdown("2 * 3 * 4", names), "2 * 3 * 4");
});
