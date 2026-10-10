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

test("fenced codeの装飾・Slackメンション・リンクはリテラルのまま表示する", () => {
  const code =
    "```\n*literal* ~literal~ <@U1> <#C1> <https://a.example|資料>\n```";
  assert.equal(toMarkdown(code, names), code);
});

test("inline codeの装飾・Slack表記を保持し、前後の通常文を変換する", () => {
  assert.equal(
    toMarkdown(
      "*前* `*literal* ~literal~ <@U1> <https://a.example|資料>` ~後~ <@U1>",
      names,
    ),
    "**前** `*literal* ~literal~ <@U1> <https://a.example|資料>` ~~後~~ @田中 太郎",
  );
});

test("複数のコード領域と通常文を混在させても各領域を保持する", () => {
  assert.equal(
    toMarkdown(
      "*前*\n```\n*literal* <@U1>\n```\n~中~ `~code~`\n```\n<https://a.example|資料>\n```\n<#C1> *後*",
      names,
    ),
    "**前**\n```\n*literal* <@U1>\n```\n~~中~~ `~code~`\n```\n<https://a.example|資料>\n```\n#general **後**",
  );
});

test("未閉じのfenced codeは末尾までリテラルとして扱う", () => {
  assert.equal(
    toMarkdown("*前*\n```\n*literal* ~literal~ <@U1>", names),
    "**前**\n```\n*literal* ~literal~ <@U1>",
  );
});

test("コード内でもAPIの文字参照を一度だけ戻し、名前解決を行わない", () => {
  assert.equal(
    toMarkdown(
      "```\n&lt;@U1&gt; &amp; &amp;lt;\n``` `&lt;#C1&gt;`\n&lt;@U1&gt; <@U1> &amp;lt;",
      names,
    ),
    "```\n<@U1> & &lt;\n``` `<#C1>`\n<@U1> @田中 太郎 &lt;",
  );
});
