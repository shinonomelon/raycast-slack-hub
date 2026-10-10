import { getPreferenceValues } from "@raycast/api";
// 型はビルドで生成するraycast-env.d.tsに依存させない。
export type Settings = { accessToken: string; previousHandles: string };
type RawSettings = { [K in keyof Settings]?: unknown };
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
export function readSettings(): Settings {
  const values = getPreferenceValues<RawSettings>();
  return {
    accessToken: text(values.accessToken),
    previousHandles: text(values.previousHandles),
  };
}

// AIのキーはSlack認証の設定から分け、任意機能を使う画面でだけ読む。
export function readReplyAISettings(): { typesafeApiKey: string } {
  const values = getPreferenceValues<{ typesafeApiKey?: unknown }>();
  return { typesafeApiKey: text(values.typesafeApiKey).trim() };
}
