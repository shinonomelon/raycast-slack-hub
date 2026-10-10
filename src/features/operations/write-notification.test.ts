import test from "node:test";
import assert from "node:assert/strict";
import { notifyOwnedWrite } from "./write-notification.ts";
import type { WriteOutcome } from "./write-outcome.ts";

test("旧認証の遅延した成功・拒否・未確認結果を通知しない", async () => {
  for (const result of [
    { kind: "succeeded", id: "Rec1" },
    { kind: "failed", message: "拒否" },
    { kind: "unconfirmed", message: "未確認" },
  ] satisfies WriteOutcome[]) {
    let resolve!: (result: WriteOutcome) => void;
    const pending = new Promise<WriteOutcome>((done) => {
      resolve = done;
    });
    let account = "old";
    let notifications = 0;
    let discarded = 0;
    const settled = notifyOwnedWrite(
      pending,
      () => account === "old",
      () => {
        notifications++;
      },
      async () => {
        discarded++;
      },
    );
    account = "new";
    resolve(result);
    assert.equal(await settled, undefined);
    assert.equal(notifications, 0);
    assert.equal(discarded, 1);
  }
});
test("認証が同じ画面終了では送信済み結果を通知し、未送信なら通知しない", async () => {
  let calls = 0;
  const result: WriteOutcome = { kind: "succeeded", id: "Rec1" };
  assert.equal(
    await notifyOwnedWrite(
      Promise.resolve(result),
      () => true,
      (outcome) => {
        assert.equal(outcome, result);
        calls++;
      },
      async () => {
        assert.fail("別認証ではない");
      },
    ),
    result,
  );
  assert.equal(
    await notifyOwnedWrite(
      Promise.resolve(undefined),
      () => true,
      () => {
        assert.fail("送信なし");
      },
      async () => {
        assert.fail("通知なし");
      },
    ),
    undefined,
  );
  assert.equal(calls, 1);
});
