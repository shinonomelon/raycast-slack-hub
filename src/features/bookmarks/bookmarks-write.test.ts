import test from "node:test";
import assert from "node:assert/strict";
import type { WriteOutcome } from "../operations/write-outcome.ts";
import { completeBookmarkWrite } from "./bookmarks-write.ts";

test("子フォームを閉じた後でも送信完了を親へ伝えて古い一覧を失効する", async () => {
  for (const outcome of [
    { kind: "succeeded", id: "Bk123" },
    { kind: "unconfirmed", message: "未確認" },
  ] satisfies WriteOutcome[]) {
    let resolve!: (outcome: WriteOutcome) => void;
    const pending = new Promise<WriteOutcome>((done) => {
      resolve = done;
    });
    let formMounted = true;
    let parentData = ["古い資料"];
    let uncertain = false;
    let notifications = 0;
    const sending = completeBookmarkWrite(
      () => pending,
      async (result) => {
        assert.equal(formMounted, false);
        notifications++;
        parentData = [];
        uncertain = result.kind === "unconfirmed";
        return false;
      },
    );
    formMounted = false;
    resolve(outcome);
    assert.deepEqual((await sending).outcome, outcome);
    assert.equal(notifications, 1);
    assert.deepEqual(parentData, []);
    assert.equal(uncertain, outcome.kind === "unconfirmed");
  }
});
test("保存後の親再取得に失敗しても保存成功や未確認の判定は変えない", async () => {
  for (const outcome of [
    { kind: "succeeded", id: "Bk123" },
    { kind: "unconfirmed", message: "未確認" },
  ] satisfies WriteOutcome[]) {
    const result = await completeBookmarkWrite(
      async () => outcome,
      async () => {
        throw new Error("再取得失敗");
      },
    );
    assert.deepEqual(result, { outcome, refreshed: false });
  }
});
test("明確な拒否では親一覧を失効せず、成功後の再取得結果を保持する", async () => {
  let calls = 0;
  const onWritten = async () => {
    calls++;
    return true;
  };
  const failed: WriteOutcome = { kind: "failed", message: "拒否" };
  assert.deepEqual(await completeBookmarkWrite(async () => failed, onWritten), {
    outcome: failed,
    refreshed: false,
  });
  assert.equal(calls, 0);
  const succeeded: WriteOutcome = { kind: "succeeded", id: "Bk123" };
  assert.deepEqual(
    await completeBookmarkWrite(async () => succeeded, onWritten),
    { outcome: succeeded, refreshed: true },
  );
  assert.equal(calls, 1);
});
