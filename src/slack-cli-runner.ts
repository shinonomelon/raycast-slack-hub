// 設定（Raycast の Preferences）を読んで slack-cli を呼ぶ。@raycast/api を読み込むので、node のテストからは値として読めない。
// 設定を読まない部分（呼び方の組み立て・プロセスの実行）は slack-cli.ts にある
import { readSettings } from "./settings.ts";
import { createRun, type Run } from "./slack-cli.ts";

// 呼ぶたびに設定を読んで、呼び方を決める。slack.ts・post.ts は Raycast を読み込まないので、
// この関数は、呼び出し側（画面・保存を扱うモジュール）から run として渡す
export const runSlackCli: Run = (args, options) =>
  createRun(readSettings())(args, options);
