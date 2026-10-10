import test from "node:test";
import assert from "node:assert/strict";
import {
  filterReplyRows,
  replyDisplayAfter,
  replyRoot,
  replySections,
} from "./reply-priority-view.ts";
import { candidateFromMatch, type ReplyCandidate } from "./reply-priority.ts";
import {
  JEV_MODEL,
  AI_PROMPT_VERSION,
  type AIResult,
} from "./reply-priority-ai.ts";

function candidate(key: string): ReplyCandidate {
  return {
    ...candidateFromMatch(
      {
        ts: "150.000000",
        text: "<@SELF>確認お願いします",
        user: "OTHER",
        thread_ts: "100.000000",
        channel: { id: "C1" },
      },
      "SELF",
      "T-SELF",
      "100.000000",
      "200.000000",
    )!,
    key,
    evidence: { kind: "no-self-post", asOf: "200.000000", checkedAt: 200000 },
    contextIncomplete: false,
  };
}
const result: AIResult = {
  neededProbability: 0.9,
  timeScore: 3,
  timeConfidence: 0.9,
  blockingScore: 2,
  blockingConfidence: 0.9,
  reminderProbability: 0.9,
  deadlineUncertainProbability: 0.1,
  contextIncomplete: false,
  model: JEV_MODEL,
  promptVersion: AI_PROMPT_VERSION,
};
test("AI OFFでも取得不足と未返信候補を分け、後続自己投稿だけを除外する", () => {
  const unknown = {
    ...candidate("unknown"),
    evidence: { kind: "unknown" as const, reason: "permission" as const },
  };
  const replied = {
    ...candidate("replied"),
    evidence: { kind: "self-post-after" as const, ts: "160.000000" },
  };
  const rows = replySections(
    [candidate("pending"), unknown, replied],
    {},
    new Map(),
    false,
    200000,
  );
  assert.deepEqual(
    rows.map((r) => [r.key, r.section]),
    [
      ["pending", "pending"],
      ["unknown", "review"],
    ],
  );
});
test("AI不要でも候補を消さず、100件の要確認から優先候補を独立取得できる", () => {
  const candidates = Array.from({ length: 100 }, (_, i) =>
    candidate(`review-${i}`),
  );
  const rows = replySections(
    [...candidates, candidate("priority"), candidate("unnecessary")],
    {},
    new Map([
      ["priority", result],
      ["unnecessary", { ...result, neededProbability: 0.1 }],
    ]),
    true,
    200000,
  );
  assert.equal(rows.length, 102);
  assert.deepEqual(
    rows.filter((r) => r.section === "needed").map((r) => r.key),
    ["priority"],
  );
  assert.equal(
    rows.filter((r) => r.section === "possibly-unnecessary").length,
    1,
  );
  assert.equal(rows[0].section, "review");
});
test("返信不要の印をAI評価と別に表示し、新しい依頼は再表示する", () => {
  const c = candidate("priority");
  const marks = {
    priority: { kind: "dismissed" as const, anchorTs: c.anchorTs, at: 199000 },
  };
  assert.equal(
    replySections([c], marks, new Map([[c.key, result]]), true, 200000)[0]
      .section,
    "hidden",
  );
  assert.equal(
    replySections(
      [{ ...c, anchorTs: "160.000000" }],
      marks,
      new Map(),
      false,
      200000,
    )[0].section,
    "pending",
  );
});
test("根を確認できない行から返信フォームを開かず、確定した親を選ぶ", () => {
  const c = candidate("root");
  assert.equal(
    replyRoot({ ...c, evidence: { kind: "unknown", reason: "root" } }),
    undefined,
  );
  assert.equal(replyRoot(c), "100.000000");
  assert.equal(
    replyRoot({
      ...c,
      key: "T:SELF:C1:unresolved-150.000000",
      evidence: { kind: "unknown", reason: "permission" },
    }),
    undefined,
  );
  assert.equal(
    replyRoot({
      ...c,
      hit: { ...c.hit, threadTs: undefined, channelKind: "im" },
    }),
    c.anchorTs,
  );
});

test("未返信候補フィルタからAI開始しても反映前のセクションと順序を変えない", () => {
  const original = { aiApplied: false, filter: "pending" };
  const scoring = replyDisplayAfter(original, "score");
  const candidates = [candidate("first"), candidate("second")];
  const staged = new Map([["second", result]]);
  const rows = replySections(
    candidates,
    {},
    new Map(),
    scoring.aiApplied,
    200000,
  );
  assert.deepEqual(
    rows.filter((r) => r.section === scoring.filter).map((r) => r.key),
    ["first", "second"],
  );
  const completedButNotApplied = replyDisplayAfter(scoring, "score");
  assert.deepEqual(completedButNotApplied, original);
  assert.equal(staged.size, 1);
  const applied = replyDisplayAfter(completedButNotApplied, "apply");
  assert.deepEqual(applied, { aiApplied: true, filter: "all" });
  assert.equal(
    replySections(candidates, {}, staged, applied.aiApplied, 200000).some(
      (r) => r.section === "needed",
    ),
    true,
  );
});
test("優先候補の表示中にAIを無効化しても未返信候補を確認できる", () => {
  const disabled = replyDisplayAfter(
    { aiApplied: true, filter: "needed" },
    "disable",
  );
  assert.deepEqual(disabled, { aiApplied: false, filter: "all" });
  const rows = replySections(
    [candidate("visible")],
    {},
    new Map(),
    disabled.aiApplied,
    200000,
  );
  assert.equal(rows[0].section, "pending");
  assert.equal(
    replyDisplayAfter({ aiApplied: true, filter: "hidden" }, "disable").filter,
    "hidden",
  );
});

test("文字検索で表示1件に絞った時はAI対象も同じ1件で非表示本文を含めない", () => {
  const rows = replySections(
    [candidate("visible"), candidate("hidden-by-search")],
    {},
    new Map(),
    false,
    200000,
  );
  const visible = filterReplyRows(rows, "all", "リリース", (row) =>
    row.key === "visible" ? "リリース承認依頼" : "経費精算依頼",
  );
  const aiInputCandidates = visible.filter((row) => row.section !== "hidden");
  assert.deepEqual(
    visible.map((row) => row.key),
    ["visible"],
  );
  assert.deepEqual(
    aiInputCandidates.map((row) => row.key),
    ["visible"],
  );
  assert.equal(
    filterReplyRows(rows, "pending", "経費", (row) =>
      row.key === "visible" ? "リリース承認依頼" : "経費精算依頼",
    ).length,
    1,
  );
});
