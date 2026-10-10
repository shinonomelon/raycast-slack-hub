import test from "node:test";
import assert from "node:assert/strict";
import {
  createReplyCredentialGate,
  guardedReplyRecheck,
} from "./reply-priority-guard.ts";

test("トークン変更時に原文とAI結果を消して送信中断し、戻しても古い応答を受け入れない", async () => {
  let credentials = { token: "fixture-a", aiKey: "fixture-key" };
  const abort = new AbortController();
  let raw = "private fixture body";
  let result: string | undefined;
  let invalidations = 0;
  const gate = createReplyCredentialGate(
    credentials,
    () => credentials,
    () => {
      invalidations++;
      abort.abort();
      raw = "";
      result = undefined;
    },
  );
  assert.equal(gate.check(), true);
  const response = Promise.resolve("late result");
  credentials = { ...credentials, token: "fixture-b" };
  assert.equal(gate.check(), false);
  if (gate.check()) result = await response;
  credentials = { token: "fixture-a", aiKey: "fixture-key" };
  assert.equal(gate.check(), false);
  assert.equal(raw, "");
  assert.equal(result, undefined);
  assert.equal(abort.signal.aborted, true);
  assert.equal(invalidations, 1);
});
test("APIキー設定変更でも同意済みセッションの次の送信を止める", () => {
  let credentials = { token: "same-user", aiKey: "key-a" };
  let sent = 0;
  let consent = true;
  const gate = createReplyCredentialGate(
    credentials,
    () => credentials,
    () => {
      consent = false;
    },
  );
  credentials = { ...credentials, aiKey: "key-b" };
  if (gate.check() && consent) sent++;
  assert.equal(sent, 0);
  assert.equal(consent, false);
});

test("返信前API待機中の更新・期間変更は中断し遅延応答でフォームを開かない", async () => {
  for (const change of ["refresh", "period", "anchor"] as const) {
    const controller = new AbortController();
    let state = {
      generation: 1,
      anchorTs: "150.000000",
      signal: controller.signal,
    };
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const recheck = guardedReplyRecheck(
      () => state,
      (signal) => {
        assert.equal(signal, controller.signal);
        return pending;
      },
    );
    if (change === "anchor") state = { ...state, anchorTs: "160.000000" };
    else {
      controller.abort();
      state = { ...state, generation: 2, signal: new AbortController().signal };
    }
    release("old scan response");
    assert.equal(await recheck, undefined);
  }
});
test("同一scanの再確認だけがフォーム用の結果を返す", async () => {
  const state = {
    generation: 1,
    anchorTs: "150.000000",
    signal: new AbortController().signal,
  };
  assert.deepEqual(
    await guardedReplyRecheck(
      () => state,
      async () => "current response",
    ),
    { kind: "ok", value: "current response" },
  );
});
