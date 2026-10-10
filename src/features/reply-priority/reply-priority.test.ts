import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromMatch,
  checkReply,
  dispositionOf,
  MARK_TTL,
  mergeCandidates,
  snoozeUntil,
  rawMessage,
  targetMessage,
} from "./reply-priority.ts";
const since = "100.000000",
  asOf = "200.000000";
const match = (
  ts = "150.000000",
  channel = "C1",
  text = "<@SELF>お願い",
  extra = {},
) => ({ ts, text, user: "OTHER", channel: { id: channel }, ...extra });
const candidate = () =>
  candidateFromMatch(
    match("150.000000", "C1", "<@SELF>お願い", { thread_ts: "50.000000" }),
    "SELF",
    "T:SELF",
    since,
    asOf,
  )!;
test("期間の両端を含み、自己・bot・system・非メンションを除く", () => {
  for (const ts of [since, asOf])
    assert.equal(
      targetMessage(
        { ts, text: "<@SELF>", userId: "OTHER" },
        false,
        "SELF",
        since,
        asOf,
      ),
      true,
    );
  for (const ts of ["99.999999", "200.000001"])
    assert.equal(
      targetMessage(
        { ts, text: "<@SELF>", userId: "OTHER" },
        false,
        "SELF",
        since,
        asOf,
      ),
      false,
    );
  for (const extra of [
    { user: "SELF" },
    { bot_id: "B" },
    { subtype: "channel_join" },
  ])
    assert.equal(
      candidateFromMatch(
        match("150.000000", "C1", "<@SELF>", extra),
        "SELF",
        "T",
        since,
        asOf,
      ),
      undefined,
    );
  assert.equal(
    candidateFromMatch(
      match("150.000000", "G1", "<!here>", {
        channel: { id: "G1", is_mpim: true },
      }),
      "SELF",
      "T",
      since,
      asOf,
    ),
    undefined,
  );
  assert.ok(
    candidateFromMatch(
      match("150.000000", "D1", "依頼"),
      "SELF",
      "T",
      since,
      asOf,
    ),
  );
});
test("古い親の新依頼を統合し、依頼より前の返答で消さない", () => {
  const c = candidate();
  const older = { ...c, anchorTs: "140.000000", firstPendingTs: "140.000000" };
  const merged = mergeCandidates([older, c]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].anchorTs, "150.000000");
  const messages = [
    { ts: "50.000000", text: "親", userId: "OTHER" },
    { ts: "145.000000", text: "回答", userId: "SELF", threadTs: "50.000000" },
    {
      ts: c.anchorTs,
      text: "<@SELF>再依頼",
      userId: "OTHER",
      threadTs: "50.000000",
    },
  ];
  assert.equal(
    checkReply(c, messages, "SELF", asOf, true, 1, since).evidence.kind,
    "no-self-post",
  );
  assert.equal(
    checkReply(
      c,
      [
        ...messages,
        {
          ts: "160.000000",
          text: "回答",
          userId: "SELF",
          threadTs: "50.000000",
        },
      ],
      "SELF",
      asOf,
      true,
      1,
      since,
    ).evidence.kind,
    "self-post-after",
  );
  assert.equal(
    checkReply(
      c,
      [
        ...messages,
        {
          ts: "160.000000",
          text: "他人回答",
          userId: "OTHER",
          threadTs: "50.000000",
        },
      ],
      "SELF",
      asOf,
      false,
      1,
      since,
    ).evidence.kind,
    "unknown",
  );
});
test("通常DMと独立スレッドの返答を混ぜず連続受信をまとめる", () => {
  const c = {
    ...candidateFromMatch(
      match("180.000000", "D1", "再依頼"),
      "SELF",
      "T",
      since,
      asOf,
    )!,
    hit: {
      ...candidateFromMatch(
        match("180.000000", "D1", "再依頼"),
        "SELF",
        "T",
        since,
        asOf,
      )!.hit,
      threadTs: undefined,
    },
  };
  const history = [
    { ts: "110.000000", text: "回答", userId: "SELF" },
    { ts: "130.000000", text: "依頼1", userId: "OTHER" },
    { ts: "180.000000", text: "依頼2", userId: "OTHER" },
    {
      ts: "190.000000",
      text: "別スレッド",
      userId: "SELF",
      threadTs: "120.000000",
    },
  ];
  const checked = checkReply(c, history, "SELF", asOf, true, 1, since);
  assert.equal(checked.firstPendingTs, "130.000000");
  assert.equal(checked.evidence.kind, "no-self-post");
});
test("印はanchorと14日期限に限定、取消は新規依頼を隠さない", () => {
  const c = candidate();
  const marks = {
    [c.key]: { kind: "dismissed" as const, anchorTs: c.anchorTs, at: 1000 },
  };
  assert.ok(dispositionOf(c, marks, 1001));
  assert.equal(
    dispositionOf({ ...c, anchorTs: "151.000000" }, marks, 1001),
    undefined,
  );
  assert.equal(dispositionOf(c, marks, 1000 + MARK_TTL), undefined);
  assert.equal(snoozeUntil("hour", 1000), 3601000);
  const now = new Date(2026, 9, 10, 23, 59).getTime();
  const next = new Date(snoozeUntil("tomorrow", now));
  assert.equal(next.getDate(), 11);
  assert.equal(next.getHours(), 9);
});
test("人のthread_broadcastは対象、既知botIDは対象外", () => {
  assert.ok(
    candidateFromMatch(
      match("150.000000", "C1", "<@SELF>依頼", {
        subtype: "thread_broadcast",
        thread_ts: "50.000000",
      }),
      "SELF",
      "T",
      since,
      asOf,
    ),
  );
  assert.equal(
    candidateFromMatch(match(), "SELF", "T", since, asOf, new Set(["OTHER"])),
    undefined,
  );
});
test("検索後の履歴で新依頼が見つかれば古い返答より新しいanchorで残す", () => {
  const c = candidateFromMatch(
    match("130.000000", "D1", "古い依頼"),
    "SELF",
    "T",
    since,
    asOf,
  )!;
  const checked = checkReply(
    c,
    [
      { ts: "130.000000", text: "古い依頼", userId: "OTHER" },
      { ts: "140.000000", text: "回答", userId: "SELF" },
      { ts: "180.000000", text: "新依頼", userId: "OTHER" },
    ],
    "SELF",
    asOf,
    true,
    1,
    since,
  );
  assert.equal(checked.anchorTs, "180.000000");
  assert.equal(checked.firstPendingTs, "180.000000");
  assert.equal(checked.evidence.kind, "no-self-post");
});

test("bot情報がないSlackbotのDMと直接メンションを検索候補から除外する", () => {
  for (const channel of ["D1", "C1"]) {
    const raw = match("180.000000", channel, "<@SELF>リマインダー", {
      user: "USLACKBOT",
    });
    assert.equal(rawMessage(raw)?.bot, true);
    assert.equal(candidateFromMatch(raw, "SELF", "T", since, asOf), undefined);
  }
  assert.ok(
    candidateFromMatch(
      match("180.000000", "C1", "<@SELF>お願い", {
        user: "HUMAN",
        username: "slackbot",
        subtype: "thread_broadcast",
      }),
      "SELF",
      "T",
      since,
      asOf,
    ),
  );
});
test("履歴のSlackbot通知を再依頼として扱わず返信済み候補を復活させない", () => {
  const c = candidateFromMatch(
    match("130.000000", "D1", "依頼"),
    "SELF",
    "T",
    since,
    asOf,
  )!;
  const checked = checkReply(
    c,
    [
      { ts: "130.000000", text: "依頼", userId: "OTHER" },
      { ts: "140.000000", text: "回答", userId: "SELF" },
      { ts: "180.000000", text: "リマインダー", userId: "USLACKBOT" },
    ],
    "SELF",
    asOf,
    true,
    1,
    since,
  );
  assert.equal(checked.anchorTs, "130.000000");
  assert.equal(checked.evidence.kind, "self-post-after");
});

test("投稿者Aに絞ってもBと本人の文脈を保持し、起点をBへ動かさない", () => {
  const original = candidateFromMatch(
    {
      ts: "100.000000",
      thread_ts: "100.000000",
      user: "UA",
      text: "<@SELF>お願い",
      channel: { id: "C1" },
    },
    "SELF",
    "T1:SELF",
    "0.000000",
    "200.000000",
  )!;
  const messages = [
    { ts: "100.000000", userId: "UA", text: "<@SELF>お願い" },
    { ts: "110.000000", threadTs: "100.000000", userId: "SELF", text: "回答" },
    {
      ts: "120.000000",
      threadTs: "100.000000",
      userId: "UB",
      text: "<@SELF>別件",
    },
  ];
  const checked = checkReply(
    original,
    messages,
    "SELF",
    "200.000000",
    true,
    200000,
    "0.000000",
    "UA",
  );
  assert.equal(checked.anchorTs, "100.000000");
  assert.equal(checked.messages.length, 3);
  assert.equal(checked.evidence.kind, "self-post-after");
});
