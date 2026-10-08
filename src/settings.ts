// 拡張の設定（package.json の preferences）。@raycast/api を読み込むので、node のテストからは値として読めない。
// 型だけを使うモジュールは import type で読む（slack-cli.ts など。値として読むと、テストの読み込みに @raycast/api が連鎖する）
import { getPreferenceValues } from "@raycast/api";

// 4つとも任意で、空欄は空文字で持つ。型は raycast-env.d.ts に頼らず、ここに書く
// （raycast-env.d.ts は ray build・ray develop が作るので、clone しただけの状態では無い）
export type Settings = {
  // 改造版 slack-cli の dist/index.js、または slack-cli のコマンドのパス。空なら決まった場所から探す
  slackCliPath: string;
  // slack-cli Path が .js のときに使う node のパス。空なら決まった場所から探す
  nodePath: string;
  // slack-cli config set --profile で付けた名前。空なら --profile を付けない
  slackCliProfile: string;
  // 改名する前のハンドル（カンマ区切り）。古いグループ DM の名前には、作ったときのハンドルが残る
  previousHandles: string;
};

type RawSettings = { [K in keyof Settings]?: unknown };

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Raycast の設定を読む。未入力は undefined で返ることがあるので、空文字にそろえる
export function readSettings(): Settings {
  const values = getPreferenceValues<RawSettings>();
  return {
    slackCliPath: text(values.slackCliPath),
    nodePath: text(values.nodePath),
    slackCliProfile: text(values.slackCliProfile),
    previousHandles: text(values.previousHandles),
  };
}
