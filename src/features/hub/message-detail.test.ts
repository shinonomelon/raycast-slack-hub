import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMatch } from "../../slack/hits.ts";
import { parseTriageEntry } from "../triage/triage.ts";
import { messageDetailBody } from "./message-detail.ts";

const names = { user: () => "本人", channel: () => "会話" };

test("通常検索の長文は詳細でも末尾と300文字以降のメンションを表示する", () => {
  const body = `${"あ".repeat(400)} <@U1> 本文の末尾`;
  const hit = normalizeMatch(
    { ts: "1.000001", channel: { id: "C1" }, text: body },
    "U1",
  );
  assert.ok(hit);
  assert.equal(hit.mentionsSelf, true);
  assert.equal(
    messageDetailBody(hit, names),
    `${"あ".repeat(400)} @本人 本文の末尾`,
  );
});

test("切れた旧キャッシュだけに短いプレビュー表示を付け、別途取得した全文を優先する", () => {
  const hit = normalizeMatch(
    { ts: "1.000001", channel: { id: "C1" }, text: "短い本文" },
    "U1",
  );
  assert.ok(hit);
  const short = parseTriageEntry({ at: 1, hits: [hit] })?.hits[0];
  assert.ok(short);
  assert.equal(messageDetailBody(short, names), "短い本文");
  const text = `${"あ".repeat(300)}…`;
  const preview = parseTriageEntry({ at: 1, hits: [{ ...hit, text }] })
    ?.hits[0];
  assert.ok(preview);
  assert.equal(
    messageDetailBody(preview, names),
    `プレビュー（⌘Rで全文を取得）\n\n${text}`,
  );
  assert.equal(
    messageDetailBody(preview, names, "取得した全文"),
    "取得した全文",
  );
});
