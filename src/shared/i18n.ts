import { messages } from "./messages.ts";

export type Language = "ja" | "en";
let language: Language = "ja";

export function setLanguage(value: unknown): Language {
  language = value === "en" ? "en" : "ja";
  return language;
}

export function getLanguage(): Language {
  return language;
}

export function getLocale(): "ja-JP" | "en-US" {
  return language === "en" ? "en-US" : "ja-JP";
}

// 引数の本文は翻訳・再置換せず、指定された位置に一度だけ入れる。
export function t(key: keyof typeof messages, ...values: unknown[]): string {
  const template = messages[key][language];
  return template.replace(/\{(\d+)\}/g, (_, index: string) =>
    String(values[Number(index)]),
  );
}

type Message = { readonly ja: string; readonly en: string };
const knownMessages = new Map<string, Message>();
const storedTemplates = Object.values(messages).flatMap((entry) =>
  [entry.ja, entry.en].flatMap((source) => {
    if (!/\{\d+\}/.test(source)) {
      knownMessages.set(source, entry);
      return [];
    }
    const indices: number[] = [];
    const pattern = source
      .split(/(\{\d+\})/g)
      .map((part) => {
        const placeholder = part.match(/^\{(\d+)\}$/);
        if (placeholder) {
          indices.push(Number(placeholder[1]));
          return "(.*?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return [{ entry, indices, pattern: new RegExp(`^${pattern}$`, "s") }];
  }),
);

// 保存済みのシステムエラーを現在の言語で表示する。投稿本文には使わない。
export function systemMessage(value: string): string {
  const known = knownMessages.get(value);
  if (known) return known[language];
  // 外部から来た長い応答は、そのまま表示して繰り返しの照合を避ける。
  if (value.length > 2000) return value;
  for (const { entry, indices, pattern } of storedTemplates) {
    const match = value.match(pattern);
    if (!match) continue;
    const values: string[] = [];
    indices.forEach((index, position) => {
      values[index] = match[position + 1];
    });
    return entry[language].replace(
      /\{(\d+)\}/g,
      (_, index: string) => values[Number(index)],
    );
  }
  return value;
}
