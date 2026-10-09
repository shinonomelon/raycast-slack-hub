import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySendError,
  classifySendResponse,
  composeMarkdown,
  confirmationOf,
  destinationLabel,
  replyParentText,
  replyParentTitle,
  replyTargetOf,
  sendTargetOf,
  shouldMarkReplied,
  slackAppChannelLink,
  slackAppMessageLink,
  slackAppUserLink,
  targetLink,
} from "./compose.ts";
import { messageLink } from "../../slack/hits.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
const TEAM = "T0000000012";
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
  const sent = classifySendResponse(other, {
    ok: true,
    channel: "C0000000001",
    ts: "1759560123.456789",
  });
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

test("未確認のとき、開く親の tsはthread_tsに渡した値。スレッド内の返信の行なら親（thread_ts）で、返信自身の ts ではない", () => {
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

test("成功応答のchannelとtsからリンクを作り、返信時は親のtsも維持する", () => {
  const data = { ok: true, channel: "D123", ts: "1759560123.456789" };
  const result = classifySendResponse(TEAM, data, "1759560100.000001");
  assert.equal(result.kind, "sent");
  if (result.kind !== "sent") return;
  assert.equal(result.channelId, "D123");
  assert.equal(result.threadTs, "1759560100.000001");
  assert.equal(
    result.link,
    messageLink(TEAM, {
      channelId: "D123",
      ts: data.ts,
      threadTs: result.threadTs!,
    }),
  );
  assert.equal(shouldMarkReplied(result, true), true);
  assert.equal(shouldMarkReplied(result, false), false);
});
test("不正な成功応答は送信未確認にし、返信済みの印を付けない", () => {
  for (const data of [
    {},
    { channel: "C1", ts: "bad" },
    { channel: "", ts: "1759560123.456789" },
    { ok: false, channel: "C1", ts: "1759560123.456789" },
  ]) {
    const result = classifySendResponse(TEAM, data);
    assert.equal(result.kind, "unconfirmed");
    assert.equal(shouldMarkReplied(result, true), false);
  }
});
test("通信・HTTP・時間切れ・内部エラーは未確認、Slackの拒否と回数制限は失敗", () => {
  for (const error of [
    new SlackApiError("network", "通信エラー"),
    new SlackApiError("http", "HTTP 500"),
    new SlackApiError("timeout", "時間切れ"),
    new SlackApiError("unreadable", "不正JSON"),
    new SlackApiError("api", "internal_error", undefined, "internal_error"),
  ]) {
    const result = classifySendError(error);
    assert.equal(result.kind, "unconfirmed");
    assert.equal(shouldMarkReplied(result, true), false);
  }
  for (const error of [
    new SlackApiError("configuration", "未設定"),
    new SlackApiError("rate_limited", "429", 30),
    new SlackApiError("api", "missing_scope", undefined, "missing_scope"),
  ])
    assert.equal(classifySendError(error).kind, "failed");
});
test("通信例外の詳細にトークンや本文があっても表示しない", () => {
  const result = classifySendError(new Error("xoxp-secret 本文の秘密"));
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("本文の秘密"));
});
