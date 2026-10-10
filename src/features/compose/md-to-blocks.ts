// Markdown を Slack の blocks と通知用 text に変換する。
// slack-messaging スキルの送信スクリプト md-to-blocks.pyの移植。
// 構成は元と同じ（見出し・段落は section の mrkdwn、箇条書きは rich_text_list、ネストは indent）。
// 元のスクリプトに無い次の扱いをここで足している：
//   - コードブロック（```）は rich_text_preformatted にする（元は中の `- ` が箇条書きになる）
//   - インラインコードの中は変換しない
//   - section の mrkdwn では & < > をエスケープする（メンションと作ったリンクは除く）
//   - 装飾が文字に密着している段落は rich_text にする（mrkdwn の *太字* は日本語に密着すると効かない）
//   - 取り消し線・斜体・引用・メンション・バックスラッシュエスケープ（エディタの Markdown 出力が付ける）

import { MessageLimitError, SECTION_TEXT_LIMIT } from "./message-limits.ts";

export type Block = Record<string, unknown>;
type RichElement = Record<string, unknown>;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^([ \t\u3000]*)([-*+•])\s+(.*)$/;
const ORDERED = /^([ \t\u3000]*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```/;

// 行頭の空白から段数を求める。半角2つ・タブ・全角スペース1つで1段（元と同じ）
function indentLevel(prefix: string): number {
  let units = 0;
  let i = 0;
  while (i < prefix.length) {
    const ch = prefix[i];
    if (ch === "\t" || ch === "\u3000") {
      units += 1;
      i += 1;
    } else if (ch === " ") {
      let n = 0;
      while (i < prefix.length && prefix[i] === " ") {
        n += 1;
        i += 1;
      }
      units += Math.floor(n / 2);
    } else {
      i += 1;
    }
  }
  return Math.min(units, 7);
}

// ---- インラインの解析 --------------------------------------------------------

type Token =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "strike" | "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "emoji"; name: string }
  | { kind: "mention"; userId: string }
  | { kind: "special"; raw: string };

// 先に書いたものほど優先する。コードを最初に取り、中を他の規則に触らせない
const INLINE = new RegExp(
  [
    "`(?<code>[^`\\n]+)`",
    "\\\\(?<esc>[!-/:-@[-`{-~])",
    "<@(?<user>[UW][A-Z0-9]+)(?:\\|[^>]*)?>",
    "(?<special><(?:#C|!)[^>\\s]+>)",
    "\\[(?<ltext>[^\\]\\n]+)\\]\\((?<lurl>[^)\\s]+)\\)",
    "\\*\\*(?<bold>.+?)\\*\\*",
    "__(?<bold2>.+?)__",
    "~~(?<strike>.+?)~~",
    "(?<![\\w*])\\*(?![\\s*])(?<italic>.+?)(?<![\\s*])\\*(?![\\w*])",
    "(?<![\\w_])_(?![\\s_])(?<italic2>.+?)(?<![\\s_])_(?![\\w_])",
    ":(?<emoji>[a-z0-9_+'-]+):",
  ].join("|"),
  "g",
);

// 装飾の中のバックスラッシュエスケープを外す
const unescapeMd = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const pushText = (s: string) => {
    if (s === "") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") last.text += s;
    else tokens.push({ kind: "text", text: s });
  };
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups ?? {};
    pushText(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (g.code !== undefined) tokens.push({ kind: "code", text: g.code });
    else if (g.esc !== undefined) pushText(g.esc);
    else if (g.user !== undefined)
      tokens.push({ kind: "mention", userId: g.user });
    else if (g.special !== undefined)
      tokens.push({ kind: "special", raw: g.special });
    else if (g.ltext !== undefined)
      tokens.push({ kind: "link", text: unescapeMd(g.ltext), url: g.lurl });
    else if (g.bold !== undefined || g.bold2 !== undefined)
      tokens.push({ kind: "bold", text: unescapeMd(g.bold ?? g.bold2) });
    else if (g.strike !== undefined)
      tokens.push({ kind: "strike", text: unescapeMd(g.strike) });
    else if (g.italic !== undefined || g.italic2 !== undefined)
      tokens.push({ kind: "italic", text: unescapeMd(g.italic ?? g.italic2) });
    else tokens.push({ kind: "emoji", name: g.emoji });
  }
  pushText(text.slice(pos));
  return tokens;
}

export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// section 用の mrkdwn（元の to_mrkdwn に相当。**b**→*b*、[t](u)→<u|t>）
function toMrkdwn(text: string): string {
  return tokenize(text)
    .map((t) => {
      switch (t.kind) {
        case "text":
          return escapeSlack(t.text);
        case "code":
          return "`" + escapeSlack(t.text) + "`";
        case "bold":
          return `*${escapeSlack(t.text)}*`;
        case "italic":
          return `_${escapeSlack(t.text)}_`;
        case "strike":
          return `~${escapeSlack(t.text)}~`;
        case "link":
          return `<${t.url}|${escapeSlack(t.text)}>`;
        case "emoji":
          return `:${t.name}:`;
        case "mention":
          return `<@${t.userId}>`;
        case "special":
          return t.raw;
      }
    })
    .join("");
}

// rich_text 用の要素（元の to_rich_elements に相当）
function toRichElements(text: string): RichElement[] {
  const elements: RichElement[] = tokenize(text).map((t) => {
    switch (t.kind) {
      case "text":
        return { type: "text", text: t.text };
      case "code":
        return { type: "text", text: t.text, style: { code: true } };
      case "bold":
        return { type: "text", text: t.text, style: { bold: true } };
      case "italic":
        return { type: "text", text: t.text, style: { italic: true } };
      case "strike":
        return { type: "text", text: t.text, style: { strike: true } };
      case "link":
        return { type: "link", url: t.url, text: t.text };
      case "emoji":
        return { type: "emoji", name: t.name };
      case "mention":
        return { type: "user", user_id: t.userId };
      case "special":
        return { type: "text", text: t.raw };
    }
  });
  return elements.length > 0 ? elements : [{ type: "text", text: "" }];
}

// 通知用 text の1行（元の _plain に相当。装飾記号を落とし、リンクは表示名だけ残す）
function toPlain(text: string): string {
  return tokenize(text)
    .map((t) => {
      switch (t.kind) {
        case "text":
          return escapeSlack(t.text);
        case "code":
          return "`" + escapeSlack(t.text) + "`";
        case "bold":
        case "italic":
        case "strike":
          return escapeSlack(t.text);
        case "link":
          return escapeSlack(t.text);
        case "emoji":
          return `:${t.name}:`;
        case "mention":
          return `<@${t.userId}>`;
        case "special":
          return t.raw;
      }
    })
    .join("");
}

// 装飾の外側が空白以外の文字に密着しているか。密着していると mrkdwn では効かない
function hasGluedStyle(text: string): boolean {
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups ?? {};
    const styled =
      g.bold !== undefined ||
      g.bold2 !== undefined ||
      g.strike !== undefined ||
      g.italic !== undefined ||
      g.italic2 !== undefined;
    if (!styled) continue;
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    if ((before && /\S/.test(before)) || (after && /\S/.test(after)))
      return true;
  }
  return false;
}

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

// 文字参照とUnicodeの書記素は途中で切らず、装飾は分割片ごとに閉じる。
// リンク・メンション・emojiは不可分として扱い、収まらないものは送信前に拒否する。
function toSections(text: string, heading = false): Block[] {
  const wrapper = heading ? "*" : "";
  const rendered = toMrkdwn(text);
  const limit = SECTION_TEXT_LIMIT - wrapper.length * 2;
  if (rendered.length <= limit) return [section(wrapper + rendered + wrapper)];

  const sections: Block[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    sections.push(section(wrapper + current + wrapper));
    current = "";
  };
  const tooLong = () => {
    throw new MessageLimitError(
      "リンク・メンション・文字がSlackのsectionの3000文字上限に収まりません。短くして投稿してください。投稿は送信していません",
    );
  };
  const appendAtomic = (value: string) => {
    if (value.length > limit) tooLong();
    if (current.length + value.length > limit) flush();
    current += value;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  function* units(value: string): Generator<string> {
    // 装飾の中でも自動リンクやemoji表記を途中で切らない。
    let pos = 0;
    for (const match of value.matchAll(
      /https?:\/\/[^\s<>]+|:[a-z0-9_+'-]+:/g,
    )) {
      for (const { segment } of segmenter.segment(
        value.slice(pos, match.index),
      ))
        yield segment;
      yield match[0];
      pos = match.index + match[0].length;
    }
    for (const { segment } of segmenter.segment(value.slice(pos)))
      yield segment;
  }
  const appendText = (value: string, marker = "") => {
    let fragment = "";
    for (const segment of units(value)) {
      const unit = escapeSlack(segment);
      if (unit.length + marker.length * 2 > limit) tooLong();
      if (
        current.length + fragment.length + unit.length + marker.length * 2 >
        limit
      ) {
        if (fragment) current += marker + fragment + marker;
        flush();
        fragment = "";
      }
      fragment += unit;
    }
    if (fragment) current += marker + fragment + marker;
  };
  for (const token of tokenize(text)) {
    switch (token.kind) {
      case "text":
        appendText(token.text);
        break;
      case "bold":
      case "italic":
      case "strike":
      case "code":
        appendText(
          token.text,
          { bold: "*", italic: "_", strike: "~", code: "`" }[token.kind],
        );
        break;
      case "link":
        appendAtomic(`<${token.url}|${escapeSlack(token.text)}>`);
        break;
      case "mention":
        appendAtomic(`<@${token.userId}>`);
        break;
      case "special":
        appendAtomic(token.raw);
        break;
      case "emoji":
        appendAtomic(`:${token.name}:`);
        break;
    }
  }
  flush();
  return sections;
}

// ---- blocks への変換 --------------------------------------------------------

export function toBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const para: string[] = [];
  const quote: string[] = [];
  const listItems: {
    style: string;
    indent: number;
    elements: RichElement[];
  }[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join("\n");
    if (hasGluedStyle(text)) {
      blocks.push({
        type: "rich_text",
        elements: [
          { type: "rich_text_section", elements: toRichElements(text) },
        ],
      });
    } else {
      blocks.push(...toSections(text));
    }
    para.length = 0;
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push({
      type: "rich_text",
      elements: [
        { type: "rich_text_quote", elements: toRichElements(quote.join("\n")) },
      ],
    });
    quote.length = 0;
  };

  // 同じ style・indent が続く項目を1つのリストにまとめ、変わったら次のリストを続ける（元と同じ）
  const flushList = () => {
    if (listItems.length === 0) return;
    const rtElements: Block[] = [];
    let run: Block[] = [];
    let curKey: { style: string; indent: number } | undefined;
    const pushRun = () => {
      if (curKey && run.length > 0) {
        rtElements.push({
          type: "rich_text_list",
          style: curKey.style,
          indent: curKey.indent,
          elements: run,
        });
      }
    };
    for (const it of listItems) {
      if (
        curKey &&
        (curKey.style !== it.style || curKey.indent !== it.indent) &&
        run.length > 0
      ) {
        pushRun();
        run = [];
      }
      curKey = { style: it.style, indent: it.indent };
      run.push({ type: "rich_text_section", elements: it.elements });
    }
    pushRun();
    blocks.push({ type: "rich_text", elements: rtElements });
    listItems.length = 0;
  };

  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };

  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({
        type: "rich_text",
        elements: [
          {
            type: "rich_text_preformatted",
            elements: [{ type: "text", text: code.join("\n") }],
          },
        ],
      });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const mb = line.match(BULLET);
    const mo = line.match(ORDERED);
    if (mb || mo) {
      flushPara();
      flushQuote();
      const [prefix, body] = mb ? [mb[1], mb[3]] : [mo![1], mo![3]];
      listItems.push({
        style: mb ? "bullet" : "ordered",
        indent: indentLevel(prefix),
        elements: toRichElements(body.trim()),
      });
      continue;
    }

    flushList();

    const mq = line.match(QUOTE);
    if (mq) {
      flushPara();
      quote.push(mq[1]);
      continue;
    }
    flushQuote();

    const mh = line.match(HEADING);
    if (mh) {
      flushPara();
      blocks.push(...toSections(mh[2].trim(), true));
      continue;
    }

    const stripped = line.trim();
    // テンプレの節見出し（■ で始まる行）は太字の section 単独ブロックにする（元と同じ）。
    // mrkdwn のテンプレを写した *■ …* の行も節見出しとみなす（元は段落のまま素通しして太字で出る。
    // ここでは *x* を Markdown どおり斜体と読むので、この形だけ拾い直す）
    if (stripped.startsWith("■") || /^\*■.*\*$/.test(stripped)) {
      flushPara();
      // 既に *…* で囲まれていれば中身だけを変換する（囲みを斜体と取り違えないため）
      const inner =
        stripped.startsWith("*") && stripped.endsWith("*")
          ? stripped.slice(1, -1)
          : stripped;
      blocks.push(...toSections(inner, true));
      continue;
    }

    para.push(line);
  }
  flushAll();
  return blocks;
}

// ---- 通知用 text ------------------------------------------------------------

export function toText(md: string): string {
  const out: string[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(escapeSlack(lines[i]));
        i += 1;
      }
      out.push("```", ...code, "```");
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    const mb = line.match(BULLET);
    const mo = line.match(ORDERED);
    const mh = line.match(HEADING);
    const mq = line.match(QUOTE);
    if (mb) {
      out.push("  ".repeat(indentLevel(mb[1])) + "• " + toPlain(mb[3].trim()));
    } else if (mo) {
      out.push(
        "  ".repeat(indentLevel(mo[1])) + `${mo[2]}. ` + toPlain(mo[3].trim()),
      );
    } else if (mh) {
      out.push(toPlain(mh[2].trim()));
    } else if (mq) {
      out.push("> " + toPlain(mq[1].trim()));
    } else {
      out.push(toPlain(line.trim()));
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
