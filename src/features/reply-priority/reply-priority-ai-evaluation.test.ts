import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROMPT_VERSION,
  JEV_MODEL,
  type AIResult,
  type ScoreOutcome,
} from "./reply-priority-ai.ts";
import {
  EVALUATION_FIXTURES,
  EVALUATION_PAIR_PROPOSALS,
  evaluateQualityGate,
  type EvaluationLabels,
} from "./reply-priority-ai-evaluation.ts";
const labels: EvaluationLabels = {
  confirmedBeforeInference: true,
  labels: Object.fromEntries(
    EVALUATION_FIXTURES.map((f) => [f.id, f.proposedLabel]),
  ),
  pairs: EVALUATION_PAIR_PROPOSALS,
};
const baseline: AIResult = {
  neededProbability: 0.95,
  timeScore: 3,
  timeConfidence: 0.9,
  blockingScore: 2,
  blockingConfidence: 0.9,
  reminderProbability: 0,
  deadlineUncertainProbability: 0,
  contextIncomplete: false,
  model: JEV_MODEL,
  promptVersion: AI_PROMPT_VERSION,
};
function outcomes(): Map<string, ScoreOutcome> {
  return new Map(
    EVALUATION_FIXTURES.map((fixture) => [
      fixture.id,
      {
        kind: "ok",
        result: {
          ...baseline,
          neededProbability:
            fixture.proposedLabel === "unnecessary"
              ? 0.05
              : fixture.proposedLabel === "ambiguous"
                ? 0.5
                : 0.95,
          timeScore: fixture.proposedLabel === "urgent" ? 3 : 0,
          blockingScore: fixture.proposedLabel === "urgent" ? 2 : 0,
        },
      },
    ]),
  );
}
test("合否採点は本人による推論前ラベル固定を必須にし、50人工例と15ペアが揃う", () => {
  assert.equal(EVALUATION_FIXTURES.length, 50);
  assert.equal(EVALUATION_PAIR_PROPOSALS.length, 15);
  assert.equal(evaluateQualityGate(outcomes()).status, "blocked");
  assert.equal(
    evaluateQualityGate(outcomes(), { ...labels, labels: {} }).status,
    "blocked",
  );
});
test("mockで評価集計式を確認するが、実Jev品質の合格証拠にはしない", () => {
  const evaluation = evaluateQualityGate(outcomes(), labels);
  assert.equal(evaluation.status, "pass");
  assert.deepEqual(evaluation.checks, {
    needed: 20,
    unnecessary: 20,
    urgentTop10: 10,
    pairs: 15,
    ambiguous: 10,
    allVisible: true,
  });
});
test("全部要確認や実API失敗では合格しない、失敗を曖昧ケースの正答に数えない", () => {
  const failed = new Map<string, ScoreOutcome>(
    EVALUATION_FIXTURES.map((f) => [f.id, { kind: "failed", reason: "auth" }]),
  );
  const gate = evaluateQualityGate(failed, labels);
  assert.equal(gate.status, "fail");
  assert.equal(gate.checks.ambiguous, 0);
  const reviewed = new Map<string, ScoreOutcome>(
    EVALUATION_FIXTURES.map((f) => [
      f.id,
      { kind: "ok", result: { ...baseline, neededProbability: 0.5 } },
    ]),
  );
  assert.equal(evaluateQualityGate(reviewed, labels).status, "fail");
});

test("比較ペアの重複とfixture外IDは採点前に拒否する", () => {
  assert.equal(
    evaluateQualityGate(outcomes(), {
      ...labels,
      pairs: Array.from({ length: 15 }, () => ["U01", "N01"] as const),
    }).status,
    "blocked",
  );
  const pairs = [...labels.pairs];
  pairs[0] = ["outside", "N01"];
  assert.equal(
    evaluateQualityGate(outcomes(), {
      ...labels,
      labels: { ...labels.labels, outside: "urgent" },
      pairs,
    }).status,
    "blocked",
  );
});

test("不正モデルと文脈欠落の要確認は曖昧例の正答に数えない", () => {
  for (const invalidResult of [
    { ...baseline, model: "wrong-model" },
    { ...baseline, neededProbability: 0.5, contextIncomplete: true },
  ]) {
    const candidates = outcomes();
    for (const fixture of EVALUATION_FIXTURES.filter(
      (f) => f.proposedLabel === "ambiguous",
    ))
      candidates.set(fixture.id, { kind: "ok", result: invalidResult });
    const gate = evaluateQualityGate(candidates, labels);
    assert.equal(gate.status, "fail");
    assert.equal(gate.checks.ambiguous, 0);
  }
});
