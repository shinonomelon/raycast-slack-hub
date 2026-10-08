import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareTs,
  isThreadReply,
  messageLink,
  normalizeMatch,
  parsePermalink,
} from "./hits.ts";

const SELF = "U0000000013";

test("ts は秒と小数部を整数で比べる（16桁で精度を落とさない）", () => {
  assert.equal(compareTs("1700000000.000100", "1700000000.000099"), 1);
  assert.equal(compareTs("1700000000.000099", "1700000000.000100"), -1);
  assert.equal(compareTs("1790967145.033309", "1790967145.033309"), 0);
  assert.equal(compareTs("1700000001.000000", "1700000000.999999"), 1);
  assert.equal(compareTs("0000000000.000000", "1700000000.000001"), -1);
  // 小数部の桁が足りなくても右を0で埋めて比べる
  assert.equal(compareTs("1700000000.1", "1700000000.099999"), 1);
});

test("permalink から会話・ts・スレッドの親を取り出す", () => {
  assert.deepEqual(
    parsePermalink(
      "https://example.slack.com/archives/C0000000007/p1791017660885899",
    ),
    { channelId: "C0000000007", ts: "1791017660.885899", threadTs: undefined },
  );
  assert.deepEqual(
    parsePermalink(
      "https://example.slack.com/archives/C0000000007/p1791043441257549?thread_ts=1790967145.033309&cid=C0000000007",
    ),
    {
      channelId: "C0000000007",
      ts: "1791043441.257549",
      threadTs: "1790967145.033309",
    },
  );
  assert.deepEqual(
    parsePermalink(
      "https://example.slack.com/archives/D0000000010/p1791017660885899",
    ),
    { channelId: "D0000000010", ts: "1791017660.885899", threadTs: undefined },
  );
  assert.equal(parsePermalink("https://example.com/foo"), undefined);
  assert.equal(
    parsePermalink("https://example.slack.com/archives/C1/p12345"),
    undefined,
  );
});

test("スレッドの親は返信とみなさない", () => {
  assert.equal(isThreadReply({ ts: "1.000001", threadTs: "1.000001" }), false);
  assert.equal(isThreadReply({ ts: "2.000001", threadTs: "1.000001" }), true);
  assert.equal(isThreadReply({ ts: "2.000001" }), false);
});

test("検索結果の1件を縮める（チャンネル・スレッド返信・自分へのメンション）", () => {
  const hit = normalizeMatch(
    {
      ts: "1791043441.257549",
      text: `<@${SELF}> 内容みてみて`,
      user: "U0000000016",
      username: "example_sender",
      permalink:
        "https://example.slack.com/archives/C0000000007/p1791043441257549?thread_ts=1790967145.033309&cid=C0000000007",
      channel: {
        id: "C0000000007",
        name: "example_channel",
        is_private: false,
      },
    },
    SELF,
  );
  assert.deepEqual(hit, {
    key: "C0000000007:1791043441.257549",
    channelId: "C0000000007",
    ts: "1791043441.257549",
    threadTs: "1790967145.033309",
    permalink:
      "https://example.slack.com/archives/C0000000007/p1791043441257549?thread_ts=1790967145.033309&cid=C0000000007",
    userId: "U0000000016",
    username: "example_sender",
    text: `<@${SELF}> 内容みてみて`,
    channelName: "example_channel",
    channelKind: "channel",
    mentionsSelf: true,
  });
});

test("会話の種類を印か ID の頭で見分ける", () => {
  const kind = (channel: object) =>
    normalizeMatch({ ts: "1.000001", text: "x", channel }, SELF)?.channelKind;
  assert.equal(kind({ id: "D123", is_im: true }), "im");
  assert.equal(kind({ id: "C123", is_mpim: true }), "mpim");
  assert.equal(kind({ id: "C123", is_private: true }), "private");
  assert.equal(kind({ id: "G123", is_group: true }), "private");
  assert.equal(kind({ id: "D123" }), "im");
  assert.equal(kind({ id: "C123" }), "channel");
});

test("bot の投稿は添付の本文を使い、長い本文は切るが、メンションは切る前に判定する", () => {
  const bot = normalizeMatch(
    {
      ts: "1.000001",
      text: "",
      attachments: [{ fallback: "デプロイ完了" }],
      channel: { id: "C1" },
    },
    SELF,
  );
  assert.equal(bot?.text, "デプロイ完了");
  assert.equal(bot?.userId, undefined);

  const long = normalizeMatch(
    {
      ts: "1.000001",
      text: `${"あ".repeat(400)} <@${SELF}>`,
      channel: { id: "C1" },
    },
    SELF,
  );
  assert.equal(long?.text.length, 301);
  assert.equal(long?.mentionsSelf, true);
});

test("会話の ID も ts も分からないものは捨てる。permalink から補えるなら補う", () => {
  assert.equal(normalizeMatch({ text: "x" }, SELF), undefined);
  assert.equal(normalizeMatch(null, SELF), undefined);
  const fromLink = normalizeMatch(
    {
      text: "x",
      permalink: "https://example.slack.com/archives/C9/p1791017660885899",
    },
    SELF,
  );
  assert.equal(fromLink?.key, "C9:1791017660.885899");
});

test("メッセージを開くリンク。スレッド返信は親の ts も付け、親そのものは最上位として開く", () => {
  assert.equal(
    messageLink("T1", { channelId: "C1", ts: "1.000002" }),
    "slack://channel?team=T1&id=C1&message=1.000002",
  );
  assert.equal(
    messageLink("T1", {
      channelId: "C1",
      ts: "1.000002",
      threadTs: "1.000001",
    }),
    "slack://channel?team=T1&id=C1&message=1.000002&thread_ts=1.000001",
  );
  assert.equal(
    messageLink("T1", {
      channelId: "C1",
      ts: "1.000001",
      threadTs: "1.000001",
    }),
    "slack://channel?team=T1&id=C1&message=1.000001",
  );
});
