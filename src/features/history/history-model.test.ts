import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../slack/hits.ts";
import {
  historyHit,
  initialHistoryRange,
  MAX_HISTORY_BYTES,
  mergeHistory,
  normalizeHistoryMessage,
  parseHistoryPage,
  resolveThreadParent,
  threadParentCandidate,
} from "./history-model.ts";

const ts = "1791600000.000001";
const hit: Hit = {
  key: `C1:${ts}`,
  channelId: "C1",
  ts,
  channelKind: "channel",
  text: "検索プレビュー",
  permalink: "https://example.slack.com/archives/C1/p1791600000000001",
  mentionsSelf: false,
};
test("検索プレビューと全文を別に保持し、thread_tsと本人メンションを正規化する", () => {
  const body = `${"本文".repeat(250)}<@U1>`;
  const message = normalizeHistoryMessage("C1", {
    ts,
    text: body,
    thread_ts: "1791599900.000001",
    user: "U2",
    reactions: [{ name: "eyes", count: 2 }],
  });
  assert.equal(message.fullText, body);
  assert.equal(message.threadTs, "1791599900.000001");
  const display = historyHit(message, hit, "U1");
  assert.equal(display.text.length, 301);
  assert.equal(display.mentionsSelf, true);
  assert.equal(hit.text, "検索プレビュー");
  assert.equal(
    historyHit({ ...message, ts: "1791600001.000001" }, hit, "U1").permalink,
    "",
  );
});
test("返信単件からの親候補は、cursorなし・要求ts一致・過去の有効thread_tsだけ", () => {
  const reply = { ts, thread_ts: "1791599900.000001", text: "reply" };
  const page = (messages: unknown[], cursor = "") =>
    parseHistoryPage("C1", {
      ok: true,
      messages,
      response_metadata: { next_cursor: cursor },
    });
  assert.equal(threadParentCandidate(page([reply]), ts), reply.thread_ts);
  for (const value of [
    page([]),
    page([reply], "next"),
    page([reply, reply]),
    page([{ ...reply, ts: "1791600001.000001" }]),
    page([{ ...reply, thread_ts: ts }]),
    page([{ ...reply, thread_ts: "1791600001.000001" }]),
    page([{ ts }]),
  ])
    assert.equal(threadParentCandidate(value, ts), undefined);
  assert.equal(threadParentCandidate(page([reply]), "bad"), undefined);
});
test("添付本文のfallbackと空本文を読む", () => {
  assert.equal(
    normalizeHistoryMessage("C1", {
      ts,
      text: "",
      attachments: [{ text: "bot本文" }],
    }).fullText,
    "bot本文",
  );
  assert.equal(normalizeHistoryMessage("C1", { ts }).fullText, "");
});
test("初回範囲は前後10分。未来側上限は開いた時刻", () => {
  assert.deepEqual(initialHistoryRange(ts, 1791600600000), {
    oldest: "1791599400.000000",
    latest: "1791600600.000000",
  });
  assert.equal(
    initialHistoryRange(ts, 1791600050000).latest,
    "1791600050.000000",
  );
});
test("時刻昇順と境界重複をまとめ、後の現行本文を採用する", () => {
  const message = (ts: string, text = ts) =>
    normalizeHistoryMessage("C1", { ts, text });
  const merged = mergeHistory(
    [message("1791600002.000001"), message("1791600001.000001")],
    [message("1791600001.000001", "更新"), message("1791600001.000002")],
  );
  assert.deepEqual(
    merged.messages.map((row) => row.ts),
    ["1791600001.000001", "1791600001.000002", "1791600002.000001"],
  );
  assert.equal(merged.messages[0].fullText, "更新");
});
test("500投稿とUTF-8本文2MiBの上限を守る", () => {
  const messages = Array.from({ length: 501 }, (_, i) =>
    normalizeHistoryMessage("C1", {
      ts: `1791600000.${String(i).padStart(6, "0")}`,
      text: "x",
    }),
  );
  assert.equal(mergeHistory([], messages).messages.length, 500);
  assert.equal(mergeHistory([], messages).capped, true);
  const large = normalizeHistoryMessage("C1", {
    ts,
    text: "あ".repeat(Math.ceil(MAX_HISTORY_BYTES / 3)),
  });
  assert.equal(mergeHistory([], [large]).messages.length, 0);
  assert.equal(mergeHistory([], [large]).capped, true);
});
test("親の応答だけでthreadTsを解決し、返信だけ・別スレッド応答を拒否", () => {
  const page = (messages: unknown[]) =>
    parseHistoryPage("C1", { ok: true, messages });
  const parent = "1791599900.000001";
  assert.equal(
    resolveThreadParent(
      page([
        { ts: parent, thread_ts: parent },
        { ts, thread_ts: parent },
      ]),
      ts,
    ),
    parent,
  );
  assert.equal(
    resolveThreadParent(page([{ ts, thread_ts: parent }]), ts),
    undefined,
  );
  assert.equal(
    resolveThreadParent(
      page([{ ts: parent }, { ts, thread_ts: "1791599000.000001" }]),
      ts,
    ),
    undefined,
  );
  assert.equal(resolveThreadParent(page([{ ts: parent }]), parent), parent);
  assert.equal(resolveThreadParent(page([]), parent), undefined);
});
test("壊れたページと続き未確定の応答を取得完了としない", () => {
  for (const data of [
    { ok: true },
    { ok: true, messages: [{ ts: "bad" }] },
    { ok: true, messages: [], has_more: true },
    { ok: true, messages: [], response_metadata: { next_cursor: 2 } },
  ])
    assert.throws(() => parseHistoryPage("C1", data));
  assert.equal(
    parseHistoryPage("C1", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "  " },
    }).cursor,
    undefined,
  );
});
