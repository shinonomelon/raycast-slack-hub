// 元の変換スクリプトで得た架空本文の期待値。実行時に外部スクリプトを参照しない。
export const PARITY_FIXTURES: Record<
  string,
  { markdown: string; blocks: unknown[]; text: string }
> = {
  段落: {
    markdown: "やあ\nうう",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "やあ\nうう",
        },
      },
    ],
    text: "やあ\nうう",
  },
  空行区切り: {
    markdown: "一段落目\n\n二段落目",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "一段落目",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "二段落目",
        },
      },
    ],
    text: "一段落目\n\n二段落目",
  },
  見出し: {
    markdown: "# 見出し\n本文",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*見出し*",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "本文",
        },
      },
    ],
    text: "見出し\n本文",
  },
  節見出し: {
    markdown: "■ 調べたこと\n本文",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*■ 調べたこと*",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "本文",
        },
      },
    ],
    text: "■ 調べたこと\n本文",
  },
  太字: {
    markdown: "これは **太字** です",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "これは *太字* です",
        },
      },
    ],
    text: "これは 太字 です",
  },
  リンク: {
    markdown: "詳しくは [Google](https://google.com) を見る",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "詳しくは <https://google.com|Google> を見る",
        },
      },
    ],
    text: "詳しくは Google を見る",
  },
  絵文字: {
    markdown: ":pray: お願いします",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":pray: お願いします",
        },
      },
    ],
    text: ":pray: お願いします",
  },
  箇条書き: {
    markdown: "- a\n- b\n* c\n• d",
    blocks: [
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
                  {
                    type: "text",
                    text: "a",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "b",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "c",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "d",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    text: "• a\n• b\n• c\n• d",
  },
  入れ子: {
    markdown: "- 親\n  - 子\n    - 孫\n- 親2",
    blocks: [
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
                  {
                    type: "text",
                    text: "親",
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text_list",
            style: "bullet",
            indent: 1,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "子",
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text_list",
            style: "bullet",
            indent: 2,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "孫",
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text_list",
            style: "bullet",
            indent: 0,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "親2",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    text: "• 親\n  • 子\n    • 孫\n• 親2",
  },
  番号付き: {
    markdown: "1. 一\n2. 二\n  1. 子",
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "ordered",
            indent: 0,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "一",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "二",
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text_list",
            style: "ordered",
            indent: 1,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "子",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    text: "1. 一\n2. 二\n  1. 子",
  },
  箇条書きの太字とリンク: {
    markdown: "- **大事** な点\n- [PR](https://example.com/pr/1) を見る",
    blocks: [
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
                  {
                    type: "text",
                    text: "大事",
                    style: {
                      bold: true,
                    },
                  },
                  {
                    type: "text",
                    text: " な点",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "link",
                    url: "https://example.com/pr/1",
                    text: "PR",
                  },
                  {
                    type: "text",
                    text: " を見る",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    text: "• 大事 な点\n• PR を見る",
  },
  混在: {
    markdown: "■ 結論\n\n結論です\n\n- 理由1\n- 理由2\n\n以上です",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*■ 結論*",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "結論です",
        },
      },
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
                  {
                    type: "text",
                    text: "理由1",
                  },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "理由2",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "以上です",
        },
      },
    ],
    text: "■ 結論\n\n結論です\n\n• 理由1\n• 理由2\n\n以上です",
  },
};
