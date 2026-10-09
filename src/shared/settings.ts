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
