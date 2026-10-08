// slack-cli の出力（JSON・エラー文）を読む純粋な関数。
// compose.ts（送信の結果の分類）と slack.ts（一覧の取得）が同じ読み方を共有する
import type { CliResult } from "./types.ts";

// chalk が色を付けたときに混ざる制御文字を取り除く。制御文字を正規表現の文字列に直接書くと lint に当たるので、コードから作る
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// slack-cli の出力から JSON 部分だけを取り出す。該当なしのときは JSON でなく文言が出るので fallback を返す
export function parseJson<T>(stdout: string, fallback: T): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) return fallback;
  return JSON.parse(stdout.slice(start)) as T;
}

// エラー文の行。slack-cli は、Slack を呼んだあとの失敗を「✗ Error: <文>」、
// 引数の検証エラー（commander の error）を、先頭に ✗ が付かない「Error: <文>」の形で標準エラーに出す
const ERROR_LINE = /^(?:✗\s*)?Error:\s*(.*)$/;

// 0 以外で終わった slack-cli のエラー文。どちらの形の行でも、前置きを除いた文を返す。
// そのような行が見つからなければ標準エラーの最後の行、それも無ければ終了コードを返す
export function cliErrorText(
  result: Pick<CliResult, "code" | "stderr">,
): string {
  const lines = stripAnsi(result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const text = ERROR_LINE.exec(line)?.[1];
    if (text) return text;
  }
  if (lines.length > 0) return lines[lines.length - 1];
  return `slack-cli が終了コード ${result.code} で終わりました`;
}
