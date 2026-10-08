import assert from "node:assert/strict";
import { test } from "node:test";
import { cliErrorText, parseJson, stripAnsi } from "./cli-output.ts";

test("色の制御文字を取り除く", () => {
  assert.equal(
    stripAnsi("\u001b[31m✗ Error:\u001b[39m A request error occurred: x"),
    "✗ Error: A request error occurred: x",
  );
  assert.equal(stripAnsi("色なし"), "色なし");
});

test("JSON の前に文字が付いていても、最初の [ か { から読む", () => {
  assert.deepEqual(parseJson('お知らせ\n[{"id":"C1"}]', []), [{ id: "C1" }]);
  assert.deepEqual(parseJson('{"ok":true}\n', {}), { ok: true });
});

test("JSON が無いとき（該当なしの文言だけが出るとき）は fallback を返す", () => {
  assert.deepEqual(parseJson("No channels found", [] as string[]), []);
  assert.deepEqual(parseJson("", { none: true }), { none: true });
});

test("壊れた JSON は読み込みの失敗として投げる", () => {
  assert.throws(() => parseJson("[{", []), SyntaxError);
});

test("Slack を呼んだあとの失敗「✗ Error: 文」から、前置きと色を除いて取り出す", () => {
  assert.equal(
    cliErrorText({
      code: 1,
      stderr: "✗ Error: An API error occurred: channel_not_found\n",
    }),
    "An API error occurred: channel_not_found",
  );
  assert.equal(
    cliErrorText({
      code: 1,
      stderr:
        "\u001b[31m✗ Error:\u001b[39m A rate limit was exceeded (retry-after: 30)\n",
    }),
    "A rate limit was exceeded (retry-after: 30)",
  );
});

test("引数の検証エラー（commander）は先頭に ✗ が付かない「Error: 文」でも、前置きを除いて取り出す", () => {
  // slack-cli の validators.ts が返す文そのもの
  assert.equal(
    cliErrorText({
      code: 1,
      stderr:
        "Error: Cannot use --user-id with --channel, --user, or --email\n",
    }),
    "Cannot use --user-id with --channel, --user, or --email",
  );
  assert.equal(
    cliErrorText({
      code: 1,
      stderr: "Error: Invalid format 'xml'. Must be one of: text, json\n",
    }),
    "Invalid format 'xml'. Must be one of: text, json",
  );
});

test("エラー文の行の前後に別の行があっても、その行の文を取り出す", () => {
  assert.equal(
    cliErrorText({
      code: 1,
      stderr:
        "お知らせの1行\n✗ Error: An API error occurred: ratelimited\n    at 後ろに続く行\n",
    }),
    "An API error occurred: ratelimited",
  );
});

test("「Error:」の行が無ければ標準エラーの最後の行を、それも無ければ終了コードを返す", () => {
  assert.equal(
    cliErrorText({
      code: 1,
      stderr: "usage: ...\nerror: unknown option '--x'\n",
    }),
    "error: unknown option '--x'",
  );
  assert.equal(
    cliErrorText({ code: 2, stderr: "" }),
    "slack-cli が終了コード 2 で終わりました",
  );
});
