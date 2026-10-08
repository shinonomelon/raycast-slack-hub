import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  buildSendArgs,
  classifyRunError,
  classifySendResult,
  composeMarkdown,
  confirmationOf,
  destinationLabel,
  replyParentText,
  replyParentTitle,
  replyTargetOf,
  SEND_TIMEOUT_MS,
  sendTargetOf,
  shouldMarkReplied,
  slackAppChannelLink,
  slackAppMessageLink,
  slackAppUserLink,
  targetLink,
} from "./compose.ts";
import { messageLink } from "./hits.ts";
import { missingError } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// ワークスペースの ID（テスト用のダミー）。リンクは、whoami で取った値を、呼び出し側が渡す
const TEAM = "T0000000012";

// 正常終了した slack-cli の結果。必要なところだけ上書きして使う
const result = (overrides: Partial<CliResult> = {}): CliResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

const sentJson = (fields: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      ok: true,
      channelId: "C0000000001",
      ts: "1759560123.456789",
      threadTs: null,
      ...fields,
    },
    null,
    2,
  );

// ---- 本文の前置き ------------------------------------------------------------------

test("メンションがあれば「メンション → 空行 → 本文」にし、無ければ本文だけにする", () => {
  assert.equal(
    composeMarkdown(["U1", "U2"], "お願いします"),
    "<@U1> <@U2>\n\nお願いします",
  );
  assert.equal(composeMarkdown([], "お願いします"), "お願いします");
});

// ---- slack:// のリンク -------------------------------------------------------------

test("会話・人・投稿の位置を開くリンクを作る", () => {
  assert.equal(
    slackAppChannelLink(TEAM, "C1"),
    "slack://channel?team=T0000000012&id=C1",
  );
  assert.equal(
    slackAppUserLink(TEAM, "U1"),
    "slack://user?team=T0000000012&id=U1",
  );
  assert.equal(
    slackAppMessageLink(TEAM, "C1", "1759560123.456789"),
    "slack://channel?team=T0000000012&id=C1&message=1759560123.456789",
  );
});

test("リンクのワークスペースの ID は、渡された値になる（決め打ちの ID を使わない）", () => {
  const other = "T0000000011";
  const expectedChannel = "slack://channel?team=T0000000011&id=C1";
  assert.equal(slackAppChannelLink(other, "C1"), expectedChannel);
  assert.equal(
    slackAppUserLink(other, "U1"),
    "slack://user?team=T0000000011&id=U1",
  );
  assert.equal(
    slackAppMessageLink(other, "C1", "1759560123.456789"),
    `${expectedChannel}&message=1759560123.456789`,
  );
  assert.equal(
    targetLink(other, { kind: "conversation", id: "C1" }),
    expectedChannel,
  );
  assert.equal(
    confirmationOf(
      other,
      { kind: "conversation", id: "C1" },
      "1759560000.000100",
    ).link,
    `${expectedChannel}&message=1759560000.000100`,
  );
  const sent = classifySendResult(other, result({ stdout: sentJson() }));
  assert.equal(sent.kind, "sent");
  if (sent.kind === "sent") {
    assert.ok(sent.link.startsWith("slack://channel?team=T0000000011&"));
    assert.ok(!sent.link.includes(TEAM));
  }
});

test("送り先を開くリンクは、会話なら会話のリンク、人ならユーザーのリンク", () => {
  assert.equal(
    targetLink(TEAM, { kind: "conversation", id: "C1" }),
    "slack://channel?team=T0000000012&id=C1",
  );
  assert.equal(
    targetLink(TEAM, { kind: "person", id: "U1" }),
    "slack://user?team=T0000000012&id=U1",
  );
  // 一覧の行から決めた送り先でも同じ（↵ で開く先と、未確認のときに開く先が同じになる）
  assert.equal(
    targetLink(TEAM, sendTargetOf({ id: "U1", kind: "person" })),
    slackAppUserLink(TEAM, "U1"),
  );
  assert.equal(
    targetLink(TEAM, sendTargetOf({ id: "G1", kind: "group" })),
    slackAppChannelLink(TEAM, "G1"),
  );
});

test("フォームの宛先の表示は、チャンネルが #名前、人が @名前、グループDM は名前に（グループDM）を添える", () => {
  assert.equal(
    destinationLabel({ kind: "channel", title: "example_remind" }),
    "#example_remind",
  );
  assert.equal(
    destinationLabel({ kind: "private", title: "times_example_user" }),
    "#times_example_user",
  );
  assert.equal(destinationLabel({ kind: "person", title: "田中" }), "@田中");
  assert.equal(
    destinationLabel({ kind: "group", title: "佐藤, 山田" }),
    "佐藤, 山田（グループDM）",
  );
});

// ---- 送信の引数 --------------------------------------------------------------------

test("一覧の行から送り先を決める。人の行は人、それ以外は会話", () => {
  assert.deepEqual(sendTargetOf({ id: "U1", kind: "person" }), {
    kind: "person",
    id: "U1",
  });
  for (const kind of ["channel", "private", "group"] as const) {
    assert.deepEqual(sendTargetOf({ id: "C1", kind }), {
      kind: "conversation",
      id: "C1",
    });
  }
});

test("会話宛ての送信の引数は -c <会話ID> --blocks-file … -f … --format json", () => {
  assert.deepEqual(
    buildSendArgs({
      target: { kind: "conversation", id: "C0000000001" },
      blocksFile: "/tmp/send-x/blocks.json",
      textFile: "/tmp/send-x/text.txt",
    }),
    [
      "send",
      "-c",
      "C0000000001",
      "--blocks-file",
      "/tmp/send-x/blocks.json",
      "-f",
      "/tmp/send-x/text.txt",
      "--format",
      "json",
    ],
  );
});

test("人宛ての送信の引数は --user-id <その人の ID> で、-c を付けない", () => {
  const args = buildSendArgs({
    target: { kind: "person", id: "U0000000013" },
    blocksFile: "/tmp/b.json",
    textFile: "/tmp/t.txt",
  });
  assert.deepEqual(args, [
    "send",
    "--user-id",
    "U0000000013",
    "--blocks-file",
    "/tmp/b.json",
    "-f",
    "/tmp/t.txt",
    "--format",
    "json",
  ]);
  assert.ok(!args.includes("-c"));
});

// ---- スレッドへの返信 ------------------------------------------------------------------

test("メッセージの行から、返信の送り先を決める。スレッドの親は、返信ならその親（thread_ts）、無ければそのメッセージ自身の ts", () => {
  // スレッド内の返信：親は thread_ts
  assert.deepEqual(
    replyTargetOf({
      channelId: "C1",
      ts: "1759560300.000300",
      threadTs: "1759560000.000100",
    }),
    {
      target: { kind: "conversation", id: "C1" },
      threadTs: "1759560000.000100",
    },
  );
  // スレッドになっていない投稿：その投稿が親になる（返信するとスレッドが始まる）
  assert.deepEqual(
    replyTargetOf({ channelId: "D1", ts: "1759560000.000100" }),
    {
      target: { kind: "conversation", id: "D1" },
      threadTs: "1759560000.000100",
    },
  );
  // 返信が付いているスレッドの親そのもの：thread_ts と ts が同じ
  assert.equal(
    replyTargetOf({
      channelId: "C1",
      ts: "1759560000.000100",
      threadTs: "1759560000.000100",
    }).threadTs,
    "1759560000.000100",
  );
});

test("返信の送信の引数に -t <スレッドの親の ts> が付く（フォームを開いた行がスレッド内の返信でも、最上位の投稿でも）", () => {
  const files = { blocksFile: "/tmp/b.json", textFile: "/tmp/t.txt" };
  const reply = buildSendArgs({
    ...replyTargetOf({
      channelId: "C0000000001",
      ts: "1759560300.000300",
      threadTs: "1759560000.000100",
    }),
    ...files,
  });
  assert.deepEqual(reply, [
    "send",
    "-c",
    "C0000000001",
    "--blocks-file",
    "/tmp/b.json",
    "-f",
    "/tmp/t.txt",
    "-t",
    "1759560000.000100",
    "--format",
    "json",
  ]);

  // threadTs が無いメッセージは、そのメッセージの ts が親
  const topLevel = buildSendArgs({
    ...replyTargetOf({ channelId: "C0000000001", ts: "1759560000.000100" }),
    ...files,
  });
  assert.deepEqual(topLevel.slice(-4), [
    "-t",
    "1759560000.000100",
    "--format",
    "json",
  ]);

  // 返信でない送信（threadTs を渡さない）には、-t が付かない
  assert.ok(
    !buildSendArgs({
      target: { kind: "conversation", id: "C1" },
      ...files,
    }).includes("-t"),
  );
});

test("投稿の位置のリンクは、スレッドの親の ts があれば thread_ts を付ける。親そのもの（ts が同じ）と、親が無いときは付けない", () => {
  assert.equal(
    slackAppMessageLink(TEAM, "C1", "1759560300.000300", "1759560000.000100"),
    "slack://channel?team=T0000000012&id=C1&message=1759560300.000300&thread_ts=1759560000.000100",
  );
  assert.equal(
    slackAppMessageLink(TEAM, "C1", "1759560000.000100", "1759560000.000100"),
    "slack://channel?team=T0000000012&id=C1&message=1759560000.000100",
  );
  assert.equal(
    slackAppMessageLink(TEAM, "C1", "1759560000.000100"),
    "slack://channel?team=T0000000012&id=C1&message=1759560000.000100",
  );
});

test("フォームに出す親メッセージの説明は、送信者・時刻・本文の先頭。本文が空なら（本文なし）", () => {
  assert.equal(
    replyParentText({
      sender: "佐藤",
      time: "2026/10/4 15:30:00",
      body: "請求書を確認してください",
    }),
    "佐藤 · 2026/10/4 15:30:00\n請求書を確認してください",
  );
  assert.equal(
    replyParentText({ sender: "bot", time: "15:30", body: "" }),
    "bot · 15:30\n（本文なし）",
  );
});

test("返信フォームの親メッセージの欄の見出し：親の行は「返信先」、スレッド内の返信の行は「スレッド内の返信」（検索結果に親の本文が無いため）", () => {
  const parent = { ts: "1759560000.000100" };
  const parentWithReplies = {
    ts: "1759560000.000100",
    threadTs: "1759560000.000100",
  };
  const reply = { ts: "1759560300.000300", threadTs: "1759560000.000100" };
  // threadTs が無い：スレッドになっていない投稿。欄に出るのが親そのもの
  assert.equal(replyParentTitle(parent), "返信先");
  // threadTs が ts と同じ：返信が付いているスレッドの親そのもの
  assert.equal(replyParentTitle(parentWithReplies), "返信先");
  // threadTs が ts と違う：スレッド内の返信。欄に出るのは選んだ返信で、親ではない
  assert.equal(replyParentTitle(reply), "スレッド内の返信");

  // 送る先（-t に渡す親）が、欄に出ているメッセージと違うときだけ、見出しを変える
  for (const hit of [parent, parentWithReplies, reply]) {
    const { threadTs } = replyTargetOf({ channelId: "C1", ...hit });
    assert.equal(
      replyParentTitle(hit) === "スレッド内の返信",
      threadTs !== hit.ts,
    );
  }
});

// ---- 送れたか未確認のときに開く先 ------------------------------------------------------

test("未確認のとき、返信は親の位置を開く。リンクは message=<親の ts> だけで、thread_ts は付けない", () => {
  const parentTs = "1759560000.000100";
  const reply = confirmationOf(
    TEAM,
    { kind: "conversation", id: "C0000000001" },
    parentTs,
  );
  assert.equal(
    reply.link,
    "slack://channel?team=T0000000012&id=C0000000001&message=1759560000.000100",
  );
  assert.ok(!reply.link.includes("thread_ts"));
  assert.equal(reply.openTitle, "Open Parent Message");
  assert.ok(reply.resendMessage.includes("スレッドの親"));
  assert.ok(reply.resendMessage.includes("返信が付いたか"));
  // 返信を宛先の会話（チャンネル）に開いても、確かめられない。チャンネルのリンクにはならない
  assert.notEqual(
    reply.link,
    targetLink(TEAM, { kind: "conversation", id: "C0000000001" }),
  );
});

test("未確認のとき、開く親の ts は -t に渡した値。スレッド内の返信の行なら親（thread_ts）で、返信自身の ts ではない", () => {
  // スレッド内の返信の行から開いたフォーム
  const inThread = replyTargetOf({
    channelId: "C1",
    ts: "1759560300.000300",
    threadTs: "1759560000.000100",
  });
  assert.equal(
    confirmationOf(TEAM, inThread.target, inThread.threadTs).link,
    "slack://channel?team=T0000000012&id=C1&message=1759560000.000100",
  );
  // スレッドになっていない投稿の行：その投稿が親
  const topLevel = replyTargetOf({ channelId: "D1", ts: "1759560000.000100" });
  assert.equal(
    confirmationOf(TEAM, topLevel.target, topLevel.threadTs).link,
    "slack://channel?team=T0000000012&id=D1&message=1759560000.000100",
  );
});

test("未確認のとき、返信でない送信は宛先の会話・人を開く。操作の名前と確認文は、返信の導入前のまま", () => {
  const conversation = confirmationOf(TEAM, { kind: "conversation", id: "C1" });
  assert.equal(
    conversation.link,
    targetLink(TEAM, { kind: "conversation", id: "C1" }),
  );
  assert.equal(conversation.openTitle, "Open Conversation");
  assert.equal(
    conversation.resendMessage,
    "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ投稿が二重になります。先に宛先の会話を開いて、確かめてください。",
  );

  const person = confirmationOf(TEAM, { kind: "person", id: "U1" });
  assert.equal(person.link, targetLink(TEAM, { kind: "person", id: "U1" }));
  assert.equal(person.link, "slack://user?team=T0000000012&id=U1");
  assert.equal(person.openTitle, "Open Conversation");
  assert.equal(person.resendMessage, conversation.resendMessage);

  // 人宛てには会話 ID が無く、親の位置のリンクを作れないので、返信の指定があっても宛先の人を開く
  assert.deepEqual(
    confirmationOf(TEAM, { kind: "person", id: "U1" }, "1759560000.000100"),
    person,
  );
});

// ---- 送信結果の分類：届いた ----------------------------------------------------------

test("正常終了で返った JSON から、投稿の位置を開くリンクを作る", () => {
  const outcome = classifySendResult(TEAM, result({ stdout: sentJson() }));
  assert.deepEqual(outcome, {
    kind: "sent",
    channelId: "C0000000001",
    ts: "1759560123.456789",
    threadTs: null,
    link: "slack://channel?team=T0000000012&id=C0000000001&message=1759560123.456789",
  });
});

test("slack-cli が実際に出す形（2文字字下げの JSON と末尾の改行）を読める", () => {
  const stdout =
    '{\n  "ok": true,\n  "channelId": "C0000000001",\n  "ts": "1791105236.550089",\n  "threadTs": null\n}\n';
  const outcome = classifySendResult(TEAM, result({ stdout }));
  assert.deepEqual(outcome, {
    kind: "sent",
    channelId: "C0000000001",
    ts: "1791105236.550089",
    threadTs: null,
    link: "slack://channel?team=T0000000012&id=C0000000001&message=1791105236.550089",
  });
});

test("DM に送ったときは、返った会話 ID（D…）で位置を開く", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ stdout: sentJson({ channelId: "D0000000009" }) }),
  );
  assert.equal(outcome.kind, "sent");
  if (outcome.kind === "sent") {
    assert.equal(outcome.channelId, "D0000000009");
    assert.equal(outcome.threadTs, null);
    assert.equal(
      outcome.link,
      "slack://channel?team=T0000000012&id=D0000000009&message=1759560123.456789",
    );
  }
});

test("スレッドへの返信が届いたときは、threadTs も持ち、リンクにも thread_ts を付けて、スレッドの中の返信を開く", () => {
  const outcome = classifySendResult(
    TEAM,
    result({
      stdout: sentJson({
        channelId: "D0000000009",
        threadTs: "1759560000.000100",
      }),
    }),
  );
  assert.equal(outcome.kind, "sent");
  if (outcome.kind === "sent") {
    assert.equal(outcome.channelId, "D0000000009");
    assert.equal(outcome.threadTs, "1759560000.000100");
    assert.equal(
      outcome.link,
      "slack://channel?team=T0000000012&id=D0000000009&message=1759560123.456789&thread_ts=1759560000.000100",
    );
    // 一覧のメッセージの行の Open in Slack（⌘↵）でスレッド返信の行を開くリンクと、同じ形
    assert.equal(
      outcome.link,
      messageLink(TEAM, {
        channelId: "D0000000009",
        ts: "1759560123.456789",
        threadTs: "1759560000.000100",
      }),
    );
  }
});

// ---- 送信結果の分類：失敗 ------------------------------------------------------------

test("Slack が断った API エラーは失敗。slack-cli のエラー文をそのまま持つ", () => {
  const outcome = classifySendResult(
    TEAM,
    result({
      code: 1,
      stderr: "✗ Error: An API error occurred: channel_not_found\n",
    }),
  );
  assert.deepEqual(outcome, {
    kind: "failed",
    message: "An API error occurred: channel_not_found",
  });
});

test("引数の検証エラー（commander）は先頭に ✗ が付かない「Error: 文」で出る。送る前に止まるので失敗", () => {
  // slack-cli の validators.ts が返す文そのもの。宛先を重ねた・形式を間違えた
  for (const text of [
    "Cannot use --user-id with --channel, --user, or --email",
    "Cannot use --channel with --user or --email",
    "Invalid format 'xml'. Must be one of: text, json",
  ]) {
    const outcome = classifySendResult(
      TEAM,
      result({ code: 1, stderr: `Error: ${text}\n` }),
    );
    assert.deepEqual(outcome, { kind: "failed", message: text });
  }
});

test("送る前に断られた回数制限は失敗（待ってから失敗する形も、すぐ失敗する形も）", () => {
  for (const text of [
    "A rate limit was exceeded (url: chat.postMessage, retry-after: 30)",
    "A rate-limit has been reached, you may retry this request in 30 seconds",
  ]) {
    const outcome = classifySendResult(
      TEAM,
      result({ code: 1, stderr: `✗ Error: ${text}\n` }),
    );
    assert.deepEqual(outcome, { kind: "failed", message: text });
  }
});

test("引数の誤りなど、エラー文の形でない0以外の終了も失敗。最後の行を持つ", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ code: 1, stderr: "error: unknown option '--user-id'\n" }),
  );
  assert.deepEqual(outcome, {
    kind: "failed",
    message: "error: unknown option '--user-id'",
  });
});

// ---- 送信結果の分類：送れたか未確認 ----------------------------------------------------

test("時間切れで止めたときは未確認（失敗にしない）", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ code: null, signal: "SIGTERM", timedOut: true }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") {
    assert.equal(outcome.reason, "timeout");
    assert.ok(outcome.message.includes(`${SEND_TIMEOUT_MS / 1000} 秒`));
  }
});

test("中断したときも未確認", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ code: null, signal: "SIGTERM", aborted: true }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") assert.equal(outcome.reason, "aborted");
});

test("通信の失敗（A request error occurred）は未確認", () => {
  const outcome = classifySendResult(
    TEAM,
    result({
      code: 1,
      stderr:
        "✗ Error: A request error occurred: getaddrinfo ENOTFOUND slack.com\n",
    }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") {
    assert.equal(outcome.reason, "request_error");
    assert.ok(outcome.message.includes("getaddrinfo ENOTFOUND slack.com"));
  }
});

test("HTTP の失敗（An HTTP protocol error occurred）は未確認", () => {
  const outcome = classifySendResult(
    TEAM,
    result({
      code: 1,
      stderr: "✗ Error: An HTTP protocol error occurred: statusCode = 502\n",
    }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") {
    assert.equal(outcome.reason, "http_error");
  }
});

test("エラー文の前置きが色の制御文字で包まれていても、通信の失敗を見分ける", () => {
  const outcome = classifySendResult(
    TEAM,
    result({
      code: 1,
      stderr:
        "\u001b[31m✗ Error:\u001b[39m A request error occurred: socket hang up\n",
    }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") {
    assert.equal(outcome.reason, "request_error");
    // 表示用の文に制御文字が残らない
    assert.ok(!outcome.message.includes("\u001b"));
  }
});

test("通信・HTTP の失敗の見分けは、行の前置き（✗ Error: ・Error: ・なし）に頼らない", () => {
  for (const stderr of [
    "✗ Error: A request error occurred: socket hang up\n",
    "Error: A request error occurred: socket hang up\n",
    "A request error occurred: socket hang up\n",
    // 前に別の行があっても、見分けられる
    "お知らせの1行\n✗ Error: A request error occurred: socket hang up\n",
  ]) {
    const outcome = classifySendResult(TEAM, result({ code: 1, stderr }));
    assert.equal(outcome.kind, "unconfirmed", JSON.stringify(stderr));
    if (outcome.kind === "unconfirmed") {
      assert.equal(outcome.reason, "request_error");
    }
  }
  for (const stderr of [
    "✗ Error: An HTTP protocol error occurred: statusCode = 503\n",
    "Error: An HTTP protocol error occurred: statusCode = 503\n",
  ]) {
    const outcome = classifySendResult(TEAM, result({ code: 1, stderr }));
    assert.equal(outcome.kind, "unconfirmed", JSON.stringify(stderr));
    if (outcome.kind === "unconfirmed") {
      assert.equal(outcome.reason, "http_error");
    }
  }
});

test("自分で止めていないのにシグナルで終わったときは未確認", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ code: null, signal: "SIGKILL" }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  if (outcome.kind === "unconfirmed") {
    assert.equal(outcome.reason, "killed");
    assert.ok(outcome.message.includes("SIGKILL"));
  }
});

test("正常終了でも応答の JSON が読めない・形が違うときは、位置が分からないので未確認", () => {
  const unreadable = [
    "",
    "✓ Message sent to #general",
    "{",
    JSON.stringify({ ok: true }),
    JSON.stringify({ ok: true, channelId: "C1" }),
    JSON.stringify({ ok: true, channelId: "C1", ts: "not-a-ts" }),
    // slack-cli は、応答に ts が無いと null を出す
    JSON.stringify({ ok: true, channelId: "C1", ts: null, threadTs: null }),
    JSON.stringify({ ok: false, channelId: "C1", ts: "1759560123.456789" }),
  ];
  for (const stdout of unreadable) {
    const outcome = classifySendResult(TEAM, result({ stdout }));
    assert.equal(
      outcome.kind,
      "unconfirmed",
      `stdout=${JSON.stringify(stdout)}`,
    );
    if (outcome.kind === "unconfirmed") {
      assert.equal(outcome.reason, "unreadable");
    }
  }
});

test("時間切れで止めたはずが、正常終了して応答が読めたときは届いたと分類する（終了コードが証拠）", () => {
  const outcome = classifySendResult(
    TEAM,
    result({ stdout: sentJson(), timedOut: true }),
  );
  assert.equal(outcome.kind, "sent");
});

// ---- 結果を得られなかったとき ------------------------------------------------------------

test("send を呼ぶ関数が reject したとき：起動できなかったなら失敗、それ以外は未確認", async () => {
  // Node が実際に返す、起動できなかったときのエラー（ENOENT）
  const spawnError = await new Promise<Error>((resolve) => {
    spawn("/nonexistent/command", []).on("error", resolve);
  });
  assert.deepEqual(classifyRunError(spawnError), {
    kind: "failed",
    message: "spawn /nonexistent/command ENOENT",
  });

  // 起動したあとに、呼び出しの側が失敗した（slack-cli.ts の出力の上限）。届いている可能性があるので未確認
  const overflow = classifyRunError(
    new Error("slack-cli の出力が上限（1000 バイト）を超えました"),
  );
  assert.equal(overflow.kind, "unconfirmed");
  if (overflow.kind === "unconfirmed") {
    assert.equal(overflow.reason, "process_error");
    assert.ok(overflow.message.includes("上限"));
    assert.ok(overflow.message.includes("届いている可能性"));
  }

  // Error でない値が投げられても、未確認（起動できなかったと言い切れない）
  assert.equal(classifyRunError("文字列").kind, "unconfirmed");
  // システムエラーでも、プロセスの起動でなければ（読み書きなど）起動できなかったとは言えない
  const readError = Object.assign(new Error("EIO: i/o error"), {
    code: "EIO",
    syscall: "read",
  });
  assert.equal(classifyRunError(readError).kind, "unconfirmed");
});

test("slack-cli や node が見つからなくて send を呼べなかったときは、何も送っていない失敗。送れたか未確認にはしない（送り直しをためらわせない）", () => {
  for (const target of ["slack-cli", "node"] as const) {
    const outcome = classifyRunError(
      missingError({
        target,
        configured: undefined,
        searched: [`/search/dir/${target}`],
      }),
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.ok(outcome.message.includes(`${target} が見つかりません`));
    }
  }
});

// ---- 送信のあとの印 ------------------------------------------------------------------

test("返信が届いたとき（成功）だけ、元のメッセージの行に印を付ける。未確認・失敗のときは付けない", () => {
  const sent = classifySendResult(
    TEAM,
    result({ stdout: sentJson({ threadTs: "1759560000.000100" }) }),
  );
  assert.equal(sent.kind, "sent");
  assert.equal(shouldMarkReplied(sent, true), true);

  // 送れたか未確認（届いていないかもしれない）：時間切れ・中断・シグナル・通信・HTTP・応答が読めない・呼び出しの失敗
  const unconfirmed = [
    classifySendResult(
      TEAM,
      result({ code: null, signal: "SIGTERM", timedOut: true }),
    ),
    classifySendResult(
      TEAM,
      result({ code: null, signal: "SIGTERM", aborted: true }),
    ),
    classifySendResult(TEAM, result({ code: null, signal: "SIGKILL" })),
    classifySendResult(
      TEAM,
      result({ code: 1, stderr: "✗ Error: A request error occurred: x\n" }),
    ),
    classifySendResult(
      TEAM,
      result({
        code: 1,
        stderr: "✗ Error: An HTTP protocol error occurred: statusCode = 502\n",
      }),
    ),
    classifySendResult(TEAM, result({ stdout: "✓ Message sent" })),
    classifyRunError(new Error("slack-cli の出力が上限を超えました")),
  ];
  for (const outcome of unconfirmed) {
    assert.equal(outcome.kind, "unconfirmed");
    assert.equal(shouldMarkReplied(outcome, true), false);
  }

  // 失敗（Slack が断った・引数の誤り・起動できない）
  const failed = [
    classifySendResult(
      TEAM,
      result({
        code: 1,
        stderr: "✗ Error: An API error occurred: not_in_channel\n",
      }),
    ),
    classifyRunError(
      Object.assign(new Error("spawn slack-cli ENOENT"), {
        code: "ENOENT",
        syscall: "spawn slack-cli",
      }),
    ),
  ];
  for (const outcome of failed) {
    assert.equal(outcome.kind, "failed");
    assert.equal(shouldMarkReplied(outcome, true), false);
  }
});

test("返信でない投稿（会話の行・人の行から書いた）は、届いても印を付けない", () => {
  const sent = classifySendResult(TEAM, result({ stdout: sentJson() }));
  assert.equal(sent.kind, "sent");
  assert.equal(shouldMarkReplied(sent, false), false);
});
