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

function sectionTexts(markdown: string): string[] {
  return toBlocks(markdown).map((block) => {
    assert.equal(block.type, "section");
    const text = (block.text as { text: string }).text;
    assert.ok(text.length <= 3000, `section length: ${text.length}`);
    return text;
  });
}

test("3000文字を超える通常段落は本文を失わずsectionへ分割する", () => {
  for (const length of [3000, 3001, 9001]) {
    const body = "あ".repeat(length);
    const texts = sectionTexts(body);
    assert.equal(texts.join(""), body);
    assert.equal(texts.length, Math.ceil(length / 3000));
  }
});

test("文字参照への変換後の長さで分割し、文字参照を途中で切らない", () => {
  for (const [character, entity] of [
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
  ]) {
    const body = "本文 " + character.repeat(3001);
    const texts = sectionTexts(body);
    assert.equal(texts.join(""), "本文 " + entity.repeat(3001));
    assert.ok(
      texts.every(
        (text) => text.replace("本文 ", "").replaceAll(entity, "") === "",
      ),
    );
  }
  assert.deepEqual(sectionTexts("&".repeat(601)), [
    "&amp;".repeat(600),
    "&amp;",
  ]);
});

test("長いMarkdown見出しとテンプレ見出しは各sectionで太字を維持する", () => {
  for (const prefix of ["# ", "■ ", "*■ "]) {
    const body = "&".repeat(1600);
    const markdown = prefix + body + (prefix.startsWith("*") ? "*" : "");
    const texts = sectionTexts(markdown);
    assert.ok(
      texts.every((text) => text.startsWith("*") && text.endsWith("*")),
    );
    assert.equal(
      texts.map((text) => text.slice(1, -1)).join(""),
      (prefix === "# " ? "" : "■ ") + "&amp;".repeat(1600),
    );
  }
});

test("分割境界のリンク・メンション・特殊表記・emojiは丸ごと残す", () => {
  const cases = [
    [
      "[表示&名](https://example.com/path)",
      "<https://example.com/path|表示&amp;名>",
    ],
    ["<@U123456>", "<@U123456>"],
    ["<!subteam^S123|team>", "<!subteam^S123|team>"],
    ["<#C123|channel>", "<#C123|channel>"],
    [":party_parrot:", ":party_parrot:"],
    ["https://example.com/path", "https://example.com/path"],
  ];
  for (const [source, rendered] of cases) {
    const prefix = "a".repeat(2995) + " ";
    const texts = sectionTexts(prefix + source + " 末尾");
    assert.equal(texts.join(""), prefix + rendered + " 末尾");
    assert.ok(texts.some((text) => text.includes(rendered)));
  }
});

test("長い装飾とinline codeは分割した各片で閉じ、内容を失わない", () => {
  for (const [sourceMarker, slackMarker] of [
    ["**", "*"],
    ["_", "_"],
    ["~~", "~"],
    ["`", "`"],
  ]) {
    const body = "あ&".repeat(1600);
    const texts = sectionTexts(sourceMarker + body + sourceMarker);
    assert.ok(
      texts.every(
        (text) => text.startsWith(slackMarker) && text.endsWith(slackMarker),
      ),
    );
    assert.equal(
      texts.map((text) => text.slice(1, -1)).join(""),
      "あ&amp;".repeat(1600),
    );
  }
});

test("Unicodeのサロゲート・結合文字・ZWJ emojiを分割しない", () => {
  for (const grapheme of ["😀", "e\u0301", "👨‍👩‍👧‍👦", "🇯🇵"]) {
    const prefix = "a".repeat(2999);
    const body = grapheme.repeat(800);
    const texts = sectionTexts(prefix + body);
    assert.equal(texts.join(""), prefix + body);
    const allGraphemes = texts.flatMap((text) =>
      Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
        (part) => part.segment,
      ),
    );
    assert.deepEqual(allGraphemes, [
      ...Array.from(prefix),
      ...Array(800).fill(grapheme),
    ]);
  }
});

test("段落途中の装飾を境界で閉じ直し、装飾内のURLとemojiも保護する", () => {
  const prefix = "a".repeat(2995) + " ";
  const body = "あ&".repeat(1600);
  const texts = sectionTexts(prefix + "**" + body + "** 末尾");
  assert.equal(
    texts.map((text) => text.replaceAll("*", "")).join(""),
    prefix + "あ&amp;".repeat(1600) + " 末尾",
  );
  assert.ok(texts.every((text) => (text.match(/\*/g)?.length ?? 0) % 2 === 0));
  for (const atomic of ["https://example.com/path", ":party_parrot:"]) {
    const styled = sectionTexts(
      "**" + "a".repeat(2990) + " " + atomic + " 末尾**",
    );
    assert.ok(styled.some((text) => text.includes(atomic)));
    assert.equal(
      styled.map((text) => text.slice(1, -1)).join(""),
      "a".repeat(2990) + " " + atomic + " 末尾",
    );
  }
});

test("1sectionに収まらない単一リンクやgraphemeは破損させず拒否する", () => {
  for (const body of [
    "[表示](https://example.com/" + "a".repeat(3000) + ")",
    "https://example.com/" + "a".repeat(3000),
    "a" + "\u0301".repeat(3000),
  ]) {
    assert.throws(() => toBlocks(body), /3000/);
  }
});
