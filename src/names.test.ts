import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "./hits.ts";
import { toPlain } from "./mrkdwn.ts";
import { buildNames } from "./names.ts";
import type { Conversation, Person } from "./types.ts";

const person = (
  id: string,
  handle: string,
  displayName: string,
  isBot = false,
): Person => ({
  id,
  handle,
  displayName,
  realName: displayName,
  title: "",
  isBot,
});

const people = [
  person("U1", "sato_y", "佐藤"),
  person("U2", "jones_f", "山田"),
  // ボットも、名前を引く対象に入る（一覧の行には出ないが、投稿者として現れる）
  person("UBOT", "deploy_bot", "デプロイ通知", true),
];

const conversations: Conversation[] = [
  { id: "C1", name: "example_remind", type: "public" },
  { id: "G1", name: "times_example_user", type: "private" },
  {
    id: "GM1",
    name: "mpdm-example_user--sato_y--jones_f-1",
    type: "mpim",
  },
];

const hit = (overrides: Partial<Hit> = {}): Hit => ({
  key: "C1:1.000001",
  channelId: "C1",
  ts: "1.000001",
  permalink: "",
  text: "",
  channelKind: "channel",
  mentionsSelf: false,
  ...overrides,
});

// 自分のハンドル（whoami の user と Previous Handles）。グループDMの名前から自分を除く
const SELF_HANDLES = ["example_user", "example_old"];

const names = buildNames(conversations, people, SELF_HANDLES);

test("本文の <@U…> は @名前 に、チャンネルへのリンクは #名前 になる（グループDM は参加者の名前を並べる）", () => {
  assert.equal(
    toPlain("<@U1> と <@U2> へ。<#C1> を見て", names.lookup),
    "@佐藤 と @山田 へ。#example_remind を見て",
  );
  assert.equal(toPlain("<#GM1>", names.lookup), "#佐藤, 山田");
  // 一覧に無い人・会話は、ラベルか ID のまま
  assert.equal(
    toPlain("<@UGONE|alice> <#CGONE>", names.lookup),
    "@alice #CGONE",
  );
  assert.equal(names.lookup.user("UGONE"), undefined);
  assert.equal(names.lookup.channel("CGONE"), undefined);
});

test("会話の表示名：チャンネルは #名前、DM は相手の名前（channel.name は相手のユーザー ID）、グループDM は参加者の名前", () => {
  assert.equal(
    names.conversationLabel(hit({ channelName: "example_remind" })),
    "#example_remind",
  );
  // 検索結果に名前が無くても、会話の一覧から引く。それも無ければ ID
  assert.equal(
    names.conversationLabel(hit({ channelId: "G1" })),
    "#times_example_user",
  );
  assert.equal(names.conversationLabel(hit({ channelId: "CGONE" })), "#CGONE");

  assert.equal(
    names.conversationLabel(
      hit({ channelId: "D1", channelKind: "im", channelName: "U1" }),
    ),
    "佐藤",
  );
  // 相手が人の一覧に無ければ DM とだけ出す
  assert.equal(
    names.conversationLabel(
      hit({ channelId: "D2", channelKind: "im", channelName: "UGONE" }),
    ),
    "DM",
  );
  assert.equal(
    names.conversationLabel(
      hit({
        channelId: "GM1",
        channelKind: "mpim",
        channelName: "mpdm-example_user--sato_y--jones_f-1",
      }),
    ),
    "佐藤, 山田",
  );
  assert.equal(
    names.conversationLabel(hit({ channelId: "GM1", channelKind: "mpim" })),
    "佐藤, 山田",
  );
  assert.equal(
    names.conversationLabel(hit({ channelId: "GMGONE", channelKind: "mpim" })),
    "グループDM",
  );
});

test("投稿者の表示名：人の名前、無ければ bot の username、それも無ければ「不明」", () => {
  assert.equal(names.sender(hit({ userId: "U1" })), "佐藤");
  assert.equal(names.sender(hit({ userId: "UBOT" })), "デプロイ通知");
  // 一覧に無い ID でも、username があればそれを出す
  assert.equal(
    names.sender(hit({ userId: "UGONE", username: "old-bot" })),
    "old-bot",
  );
  assert.equal(names.sender(hit({ username: "release-bot" })), "release-bot");
  assert.equal(names.sender(hit()), "不明");
});

test("ユーザー ID からハンドルを引く。分からなければ undefined", () => {
  assert.equal(names.handleOf("U1"), "sato_y");
  assert.equal(names.handleOf("UGONE"), undefined);
  assert.equal(names.handleOf(undefined), undefined);
});

test("グループDMの名前から除く自分のハンドルは、渡された一覧で決まる", () => {
  const group = hit({
    channelKind: "mpim",
    channelId: "GM1",
    channelName: "mpdm-example_user--sato_y--jones_f-1",
  });
  assert.equal(names.conversationLabel(group), "佐藤, 山田");
  // 自分のハンドルを渡さなければ、除かない
  const noSelf = buildNames(conversations, people, []);
  assert.equal(noSelf.conversationLabel(group), "example_user, 佐藤, 山田");
  assert.equal(noSelf.lookup.channel("GM1"), "example_user, 佐藤, 山田");
});
