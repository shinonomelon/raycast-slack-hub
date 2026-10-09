// ID から表示名を引く。キャッシュに無ければ undefined を返す
export type NameLookup = {
  user: (id: string) => string | undefined;
  channel: (id: string) => string | undefined;
};

type Mode = "plain" | "markdown";

// <@U…|ラベル>・<#C…|名前>・<!here>・<url|ラベル> を読める形にする
function replaceSpecial(text: string, names: NameLookup, mode: Mode): string {
  return text.replace(/<([^<>]+)>/g, (whole, inner: string) => {
    const [target, label] = splitLabel(inner);
    if (/^@[UW][A-Z0-9]+$/.test(target)) {
      const id = target.slice(1);
      return `@${names.user(id) ?? label ?? id}`;
    }
    if (/^#[CG][A-Z0-9]+$/.test(target)) {
      const id = target.slice(1);
      return `#${names.channel(id) ?? label ?? id}`;
    }
    if (target.startsWith("!")) {
      const command = target.slice(1);
      if (["here", "channel", "everyone"].includes(command))
        return `@${command}`;
      if (command.startsWith("subteam^")) return label ?? "@group";
      return label ?? whole;
    }
    if (/^(https?|mailto):/.test(target)) {
      const shown = label ?? target.replace(/^mailto:/, "");
      return mode === "markdown" && label ? `[${label}](${target})` : shown;
    }
    return whole;
  });
}

function splitLabel(inner: string): [string, string | undefined] {
  const bar = inner.indexOf("|");
  return bar < 0
    ? [inner, undefined]
    : [inner.slice(0, bar), inner.slice(bar + 1)];
}

// Slack は本文の < > & を文字参照で送る。&amp; を最後に戻すことで、&amp;lt; を二重に戻さない
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// 一覧の見出し用。改行と連続する空白を1つの空白にまとめ、長ければ切る
export function toPlain(
  text: string,
  names: NameLookup,
  maxLength = 120,
): string {
  const plain = decodeEntities(replaceSpecial(text, names, "plain"))
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}

// 囲み記号の中身。空白で始まる・終わるものは囲みとみなさない（2 * 3 * 4 を太字にしない）
const inner = (mark: string) =>
  `([^${mark}\\s](?:[^${mark}\\n]*[^${mark}\\s])?)`;
const BOLD = new RegExp(`(^|\\s)\\*${inner("*")}\\*(?=\\s|$|[.,!?、。])`, "g");
const STRIKE = new RegExp(`(^|\\s)~${inner("~")}~(?=\\s|$|[.,!?、。])`, "g");

// 詳細ペイン用。Slack の太字 *x* と打ち消し ~x~ を Markdown の書き方に直す
export function toMarkdown(text: string, names: NameLookup): string {
  return decodeEntities(replaceSpecial(text, names, "markdown"))
    .replace(BOLD, "$1**$2**")
    .replace(STRIKE, "$1~~$2~~");
}
