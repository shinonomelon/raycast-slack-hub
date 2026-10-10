import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageLimitError, validateMessageBlocks } from "./message-limits.ts";

test("送信前にsectionの上限を再検証する", () => {
  const section = (text: string) => ({
    type: "section",
    text: { type: "mrkdwn", text },
  });
  assert.doesNotThrow(() => validateMessageBlocks([section("a".repeat(3000))]));
  for (const block of [
    section("a".repeat(3001)),
    section(""),
    { type: "section" },
  ]) {
    assert.throws(() => validateMessageBlocks([block]), MessageLimitError);
  }
});

test("section以外も含めて50blocks上限を検証する", () => {
  const blocks = Array.from({ length: 50 }, () => ({
    type: "rich_text",
    elements: [],
  }));
  assert.doesNotThrow(() => validateMessageBlocks(blocks));
  assert.throws(
    () => validateMessageBlocks([...blocks, { type: "divider" }]),
    MessageLimitError,
  );
});
