import assert from "node:assert/strict";
import { test } from "node:test";
import { toBlocks, toText } from "./md-to-blocks.ts";
import { PARITY_FIXTURES } from "./md-to-blocks.fixtures.ts";

for (const [name, expected] of Object.entries(PARITY_FIXTURES)) {
  test(`元の変換スクリプトの固定期待値と一致：${name}`, () => {
    assert.deepEqual(toBlocks(expected.markdown), expected.blocks);
    assert.equal(toText(expected.markdown), expected.text);
  });
}

// ---- 元のスクリプトの穴を塞いだ部分 -----------------------------------------

test("+ の箇条書きは、プレビューと同じリストとして投稿用データに変換する", () => {
  const markdown = "+ 一項目\n  + 子項目\n+ **二項目**";
  const expected = "- 一項目\n  - 子項目\n- **二項目**";
  assert.deepEqual(toBlocks(markdown), toBlocks(expected));
  assert.equal(toText(markdown), "• 一項目\n  • 子項目\n• 二項目");
});

test("コード内や通常の文章の + は箇条書きに変換しない", () => {
  assert.deepEqual(toBlocks("```\n+ 一項目\n```"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_preformatted",
          elements: [{ type: "text", text: "+ 一項目" }],
        },
      ],
    },
  ]);
  assert.equal(toText("```\n+ 一項目\n```"), "```\n+ 一項目\n```");
  assert.deepEqual(toBlocks("C++ と a+b と +1"), [
    { type: "section", text: { type: "mrkdwn", text: "C++ と a+b と +1" } },
  ]);
  assert.equal(toText("C++ と a+b と +1"), "C++ と a+b と +1");
});

test("コードブロックの中は箇条書きにも太字にもしない", () => {
  assert.deepEqual(toBlocks("```\n- a\n**b**\n```"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_preformatted",
          elements: [{ type: "text", text: "- a\n**b**" }],
        },
      ],
    },
  ]);
  assert.equal(toText("```\n- a\n```"), "```\n- a\n```");
});

test("インラインコードの中は変換しない", () => {
  assert.deepEqual(toBlocks("`**x**` です"), [
    { type: "section", text: { type: "mrkdwn", text: "`**x**` です" } },
  ]);
  assert.deepEqual(toBlocks("- `a**b**`"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 0,
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "a**b**", style: { code: true } },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test("& < > をエスケープし、メンションとリンクは残す", () => {
  assert.deepEqual(toBlocks("a & b <c> <@U123> [t](https://x.y)"), [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "a &amp; b &lt;c&gt; <@U123> <https://x.y|t>",
      },
    },
  ]);
  assert.equal(toText("a & b <@U123>"), "a &amp; b <@U123>");
});

test("日本語に密着した太字は rich_text の bold にする", () => {
  assert.deepEqual(toBlocks("これは**太字**です"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "これは" },
            { type: "text", text: "太字", style: { bold: true } },
            { type: "text", text: "です" },
          ],
        },
      ],
    },
  ]);
});

test("取り消し線・斜体", () => {
  assert.deepEqual(toBlocks("a ~~b~~ *c* _d_"), [
    { type: "section", text: { type: "mrkdwn", text: "a ~b~ _c_ _d_" } },
  ]);
  assert.equal(toText("a ~~b~~ *c*"), "a b c");
});

test("mrkdwn のテンプレを写した *■ …* の行は節見出し（元は段落と1つの section にまとめる）", () => {
  assert.deepEqual(toBlocks("*■ 調べたこと*\n本文"), [
    { type: "section", text: { type: "mrkdwn", text: "*■ 調べたこと*" } },
    { type: "section", text: { type: "mrkdwn", text: "本文" } },
  ]);
});

test("snake_case の _ は斜体にしない", () => {
  assert.deepEqual(toBlocks("foo_bar_baz"), [
    { type: "section", text: { type: "mrkdwn", text: "foo_bar_baz" } },
  ]);
});

test("引用は rich_text_quote", () => {
  assert.deepEqual(toBlocks("> 一行目\n> **二行目**"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_quote",
          elements: [
            { type: "text", text: "一行目\n" },
            { type: "text", text: "二行目", style: { bold: true } },
          ],
        },
      ],
    },
  ]);
});

test("メンションは rich_text では user 要素", () => {
  assert.deepEqual(toBlocks("- <@U0000000015> さん"), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 0,
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "U0000000015" },
                { type: "text", text: " さん" },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test("Markdown のバックスラッシュエスケープを外す", () => {
  assert.deepEqual(toBlocks("snake\\_case と 1\\*2"), [
    { type: "section", text: { type: "mrkdwn", text: "snake_case と 1*2" } },
  ]);
  assert.equal(toText("a \\< b"), "a &lt; b");
});
