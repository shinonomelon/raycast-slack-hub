import { getPreferenceValues } from "@raycast/api";
import { setLanguage } from "./i18n.ts";

export function configureLanguage() {
  return setLanguage(getPreferenceValues<{ language?: unknown }>().language);
}
// 型はビルドで生成するraycast-env.d.tsに依存させない。
export type Settings = {
  accessToken: string;
  previousHandles: string;
  backgroundRefreshFrequency?: RefreshFrequency;
};
export type RefreshFrequency = "30m" | "1h" | "3h" | "off";
export function refreshFrequency(value: unknown): RefreshFrequency {
  return value === "1h" || value === "3h" || value === "off" ? value : "30m";
}
export function refreshIntervalMs(value: unknown): number {
  const frequency = refreshFrequency(value);
  return frequency === "1h" ? 3600000 : frequency === "3h" ? 10800000 : 1800000;
}
type RawSettings = { [K in keyof Settings]?: unknown };
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
export function readSettings(): Settings {
  const values = getPreferenceValues<RawSettings>();
  return {
    accessToken: text(values.accessToken),
    previousHandles: text(values.previousHandles),
    backgroundRefreshFrequency: refreshFrequency(
      values.backgroundRefreshFrequency,
    ),
  };
}

// AIのキーはSlack認証の設定から分け、任意機能を使う画面でだけ読む。
export function readReplyAISettings(): { typesafeApiKey: string } {
  const values = getPreferenceValues<{ typesafeApiKey?: unknown }>();
  return { typesafeApiKey: text(values.typesafeApiKey).trim() };
}
