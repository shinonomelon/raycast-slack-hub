import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackApiError } from "../../slack/slack-api.ts";
import {
  createWriteLock,
  runWrite,
  writeOutcomeError,
  type WriteOutcome,
} from "./write-outcome.ts";

test("権限拒否・送信前の429と、部分成功可能な失敗を区別する", () => {
  for (const code of ["missing_scope", "invalid_auth", "permission_denied"])
    assert.equal(
      writeOutcomeError(new SlackApiError("api", "拒否", undefined, code)).kind,
      "failed",
    );
  assert.equal(
    writeOutcomeError(new SlackApiError("rate_limited", "待機")).kind,
    "failed",
  );
  for (const code of ["internal_error", "fatal_error", "unknown_error"])
    assert.equal(
      writeOutcomeError(new SlackApiError("api", "不明", undefined, code)).kind,
      "unconfirmed",
    );
  for (const kind of [
    "http",
    "network",
    "timeout",
    "unreadable",
    "aborted",
  ] as const)
    assert.equal(
      writeOutcomeError(new SlackApiError(kind, "不明")).kind,
      "unconfirmed",
    );
});
test("応答の識別子が不正なら未確認とし、自動再送しない", async () => {
  let calls = 0;
  const outcome = await runWrite(
    async () => {
      calls++;
      return { ok: true };
    },
    "slackLists.items.create",
    {},
    (data) => typeof data.id === "string",
  );
  assert.equal(outcome.kind, "unconfirmed");
  assert.equal(calls, 1);
});
test("同時送信は1回、結果未確認後は直接再送しない", async () => {
  const lock = createWriteLock();
  let done!: (outcome: WriteOutcome) => void;
  let calls = 0;
  const action = () => {
    calls++;
    return new Promise<WriteOutcome>((resolve) => {
      done = resolve;
    });
  };
  const first = lock.run(action);
  assert.equal(await lock.run(action), undefined);
  assert.equal(calls, 1);
  done({ kind: "unconfirmed", message: "未確認" });
  await first;
  assert.equal(await lock.run(action), undefined);
  assert.equal(calls, 1);
});
test("明確な拒否後は入力修正のため再試行できる", async () => {
  const lock = createWriteLock();
  assert.equal(
    (await lock.run(async () => ({ kind: "failed", message: "権限不足" })))
      ?.kind,
    "failed",
  );
  assert.equal(
    (await lock.run(async () => ({ kind: "succeeded", id: "R1" })))?.kind,
    "succeeded",
  );
});
