import test from "node:test";
import assert from "node:assert/strict";
import { createTaskFormSubmission } from "./task-form-submission.ts";
import { writeTask } from "./task-write.ts";
import type { ApiCall } from "../../slack/slack-api.ts";
import { fixtureList, fixtureSession, RAW_LIST } from "./test-fixtures.ts";

test("成功応答後の一覧再取得/toast/pop待機中も同じFormの再Submitを拒否", async () => {
  const submission = createTaskFormSubmission();
  let writes = 0;
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const submit = async () => {
    if (!submission.begin()) return;
    writes++;
    submission.accept({ kind: "succeeded", id: "RecNEW" });
    await refresh;
  };
  const first = submit();
  assert.equal(submission.succeeded, true);
  assert.equal(submission.canSubmit, false);
  await submit();
  assert.equal(writes, 1);
  releaseRefresh();
  await first;
  await submit();
  assert.equal(writes, 1);
});
test("pendingの二度押しは0回、明確な失敗後だけ入力を維持して再送できる", () => {
  const submission = createTaskFormSubmission();
  assert.equal(submission.begin(), true);
  assert.equal(submission.begin(), false);
  submission.accept({ kind: "failed", message: "missing_scope" });
  assert.equal(submission.canSubmit, true);
  assert.equal(submission.begin(), true);
});
test("結果未確認と成功のラッチをunstarted解除で開かない", () => {
  for (const outcome of [
    { kind: "succeeded", id: "RecNEW" },
    { kind: "unconfirmed", message: "timeout" },
  ] as const) {
    const submission = createTaskFormSubmission();
    submission.begin();
    submission.accept(outcome);
    submission.releaseUnstarted();
    assert.equal(submission.canSubmit, false);
    assert.equal(submission.begin(), false);
  }
});
test("preflight中のEscはmutationを始めず、送信前の失敗になる", async () => {
  let mounted = true;
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const api: ApiCall = async (method) => {
    if (method === "slackLists.items.list") {
      await pause;
      return { ok: true, list: RAW_LIST, items: [] };
    }
    writes++;
    return { ok: true, item: { id: "RecNEW", list_id: "FTEST" } };
  };
  const pending = writeTask({
    session: fixtureSession(api),
    list: fixtureList(),
    kind: "create",
    values: { title: "New" },
    isCurrent: () => mounted,
  });
  mounted = false;
  release();
  assert.equal((await pending).kind, "failed");
  assert.equal(writes, 0);
});
