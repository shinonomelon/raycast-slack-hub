import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROMPT_VERSION,
  JEV_MODEL,
  prepareAIInput,
  parseAIResponse,
  classifyAIResult,
  rankAICandidates,
  createJevScorer,
  scoreAIRound,
  aiInputHash,
  aiReasons,
  type AIInput,
  type AIResult,
} from "./reply-priority-ai.ts";

const input: AIInput = {
  messages: [
    { ts: "100.000000", text: "<@U1> 確認してください", userId: "U2" },
  ],
  rootTs: "100.000000",
  anchorTs: "100.000000",
  selfId: "U1",
  asOf: "200.000000",
  timezone: "Asia/Tokyo",
  evidenceComplete: true,
};
const result: AIResult = {
  neededProbability: 0.8,
  timeScore: 3,
  timeConfidence: 0.6,
  blockingScore: 2,
  blockingConfidence: 0.6,
  reminderProbability: 0.8,
  deadlineUncertainProbability: 0,
  contextIncomplete: false,
  model: JEV_MODEL,
  promptVersion: AI_PROMPT_VERSION,
};
function response() {
  return {
    model: JEV_MODEL,
    answers: {
      needed: { type: "noul", noul: 0.8 },
      time: { type: "score", score: 3, confidence: 0.6 },
      blocking: { type: "score", score: 2, confidence: 0.6 },
      reminder: { type: "noul", noul: 0.8 },
      deadlineUncertain: { type: "noul", noul: 0 },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test("必要性の境界0.2/0.8を含めて候補を分類し、中間・低確信・期限不明を要確認にする", () => {
  assert.equal(classifyAIResult(result).kind, "needed");
  assert.equal(
    classifyAIResult({ ...result, neededProbability: 0.2 }).kind,
    "possibly-unnecessary",
  );
  assert.deepEqual(classifyAIResult({ ...result, neededProbability: 0.5 }), {
    kind: "review",
    reason: "necessity",
  });
  assert.deepEqual(classifyAIResult({ ...result, timeConfidence: 0.599 }), {
    kind: "review",
    reason: "confidence",
  });
  assert.deepEqual(
    classifyAIResult({ ...result, deadlineUncertainProbability: 0.5 }),
    { kind: "review", reason: "deadline" },
  );
  assert.deepEqual(classifyAIResult(result, false), {
    kind: "review",
    reason: "context",
  });
  assert.equal(
    classifyAIResult({ ...result, neededProbability: NaN }).kind,
    "review",
  );
});

test("欠落・型違い・範囲外・非固定modelの回答は採用しない", () => {
  assert.deepEqual(parseAIResponse(response(), false), result);
  for (const name of [
    "needed",
    "time",
    "blocking",
    "reminder",
    "deadlineUncertain",
  ] as const) {
    const raw = response();
    delete (raw.answers as Record<string, unknown>)[name];
    assert.equal(parseAIResponse(raw, false), undefined);
  }
  const raw = response();
  raw.answers.time.score = 3.1;
  assert.equal(parseAIResponse(raw, false), undefined);
  assert.equal(
    parseAIResponse({ ...response(), model: "jev-latest" }, false),
    undefined,
  );
});

test("原文の300文字以降の期限を保持し、ユーザーIDとリンク表示を相対化する", () => {
  const text = `${"説明".repeat(200)} <@U1> <https://example.com|資料> 今日中に回答ください`;
  const prepared = prepareAIInput({
    ...input,
    messages: [{ ...input.messages[0], text }],
  });
  assert.equal(prepared.contextIncomplete, false);
  assert.ok(
    prepared.state.messages[0].text.endsWith("@self 資料 今日中に回答ください"),
  );
  assert.equal(JSON.stringify(prepared.state).includes("U1"), false);
  assert.equal(JSON.stringify(prepared.state).includes("U2"), false);
});

test("相対期限の基準となる現地日時を補い、日時やタイムゾーンが壊れた場合は要確認にする", () => {
  const dated = {
    ...input,
    asOf: "1791604800.000000",
    rootTs: "1791597600.000000",
    anchorTs: "1791597600.000000",
    messages: [{ ...input.messages[0], ts: "1791597600.000000" }],
  };
  const prepared = prepareAIInput(dated);
  assert.equal(prepared.state.asOfLocal, "2026-10-10 13:00:00 GMT+9");
  assert.equal(
    prepared.state.messages[0].postedAtLocal,
    "2026-10-10 11:00:00 GMT+9",
  );
  assert.equal(prepared.contextIncomplete, false);
  assert.ok(JSON.stringify(prepared.state).length <= 16000);
  assert.equal(
    prepareAIInput({ ...dated, timezone: "Invalid/Zone" }).contextIncomplete,
    true,
  );
  assert.equal(
    prepareAIInput({ ...dated, asOf: "broken" }).contextIncomplete,
    true,
  );
});

test("本人の後続投稿は対象より後から取得時点までだけ数え、不完全な履歴では断定しない", () => {
  for (const [ts, expected] of [
    ["100.000000", false],
    ["101.000000", true],
    ["200.000000", true],
    ["201.000000", false],
  ] as const) {
    const prepared = prepareAIInput({
      ...input,
      messages: [...input.messages, { ts, text: "回答", userId: input.selfId }],
    });
    assert.equal(prepared.state.selfPostAfterTarget, expected);
    if (ts === "201.000000")
      assert.equal(
        prepared.state.messages.some((m) => m.ts === ts),
        false,
      );
  }
  assert.equal(
    prepareAIInput({ ...input, evidenceComplete: false }).state
      .selfPostAfterTarget,
    null,
  );
});

test("30投稿・16000文字を超える場合、親・最新依頼を残し必ず要確認にする", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    ts: `${100 + i}.000000`,
    text: "文脈".repeat(300),
    userId: "U2",
  }));
  const prepared = prepareAIInput({
    ...input,
    messages: many,
    anchorTs: "139.000000",
  });
  assert.ok(prepared.state.messages.length <= 30);
  assert.ok(
    prepared.state.messages.reduce((n, m) => n + m.text.length, 0) <= 16000,
  );
  assert.ok(prepared.state.messages.some((m) => m.ts === input.rootTs));
  assert.ok(prepared.state.messages.some((m) => m.ts === "139.000000"));
  assert.equal(prepared.contextIncomplete, true);
  assert.equal(
    classifyAIResult({ ...result, contextIncomplete: true }).kind,
    "review",
  );
  assert.equal(
    prepareAIInput({ ...input, fileOnly: true }).contextIncomplete,
    true,
  );
  assert.equal(
    prepareAIInput({ ...input, rootTs: "99.000000" }).contextIncomplete,
    true,
  );
  assert.equal(
    prepareAIInput({
      ...input,
      messages: [{ ...input.messages[0], text: "x".repeat(16001) }],
    }).contextIncomplete,
    true,
  );
});

test("要確認を先頭に保ち、式・催促・古い待ち・キーで安定順位、不要候補も残す", () => {
  const row = (key: string, ai: AIResult | undefined, extra = {}) => ({
    key,
    anchorTs: "100.000000",
    firstUnansweredTs: "100.000000",
    evidenceComplete: true,
    ai,
    ...extra,
  });
  const items = [
    row("b", result),
    row("a", result),
    row("low", { ...result, timeScore: 0, blockingScore: 0 }),
    row("unnecessary", { ...result, neededProbability: 0.1 }),
    row("review", undefined),
    row("reminder", { ...result, reminderProbability: 0.9 }),
    row("older", result, { firstUnansweredTs: "99.999999" }),
  ];
  assert.deepEqual(
    rankAICandidates(items).map((r) => r.key),
    ["review", "reminder", "older", "a", "b", "low", "unnecessary"],
  );
  assert.equal(rankAICandidates(items).length, items.length);
  assert.deepEqual(aiReasons(result), [
    "期限が近い可能性",
    "作業が止まっている可能性",
    "催促ありの可能性",
  ]);
  assert.notEqual(aiInputHash(input), aiInputHash({ ...input, selfId: "U3" }));
});

test("キーが空なら環境キーへフォールバックせず、送信しない", async () => {
  let calls = 0;
  const scorer = createJevScorer("  ", {
    fetch: async () => {
      calls++;
      throw Error("must not run");
    },
  });
  assert.deepEqual(await scorer.score(input), {
    kind: "failed",
    reason: "key",
  });
  assert.equal(calls, 0);
});

test("公式送信先・明示キー・固定modelを使い、429でretryせず匿名分類を返す", async () => {
  let calls = 0;
  const scorer = createJevScorer("test-key", {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init?.redirect, "error");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-key",
      );
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, JEV_MODEL);
      assert.ok(!JSON.stringify(body.state).includes("U1"));
      return new Response(
        JSON.stringify({ error: "secret message must not appear" }),
        { status: 429, headers: { "retry-after": "23" } },
      );
    },
  });
  assert.deepEqual(await scorer.score(input), {
    kind: "failed",
    reason: "rate",
    retryAfterMs: 23000,
  });
  assert.equal(calls, 1);
});

test("Jev過負荷でも自動再試行せず、ミリ秒とHTTP日時の待機指定を守る", async () => {
  for (const [status, headers, expected] of [
    [529, { "retry-after-ms": "1200", "retry-after": "30" }, 1200],
    [
      429,
      { "retry-after": new Date(Date.now() + 120_000).toUTCString() },
      undefined,
    ],
  ] as const) {
    let calls = 0;
    const scorer = createJevScorer("test-key", {
      fetch: async () => {
        calls++;
        return new Response("{}", { status, headers });
      },
    });
    const outcome = await scorer.score(input);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") assert.fail("過負荷の結果を採用しない");
    assert.equal(outcome.reason, "rate");
    if (expected !== undefined) assert.equal(outcome.retryAfterMs, expected);
    else
      assert.ok(
        outcome.retryAfterMs! > 115_000 && outcome.retryAfterMs! <= 120_000,
      );
    assert.equal(calls, 1);
  }
});

test("環境のデバッグ・送信先・キー指定があっても設定キーと公式送信先を使いログを出さない", async () => {
  const names = [
    "TYPESAFE_LOG_LEVEL",
    "TYPESAFE_BASE_URL",
    "TYPESAFE_API_KEY",
  ] as const;
  const original = names.map((name) => process.env[name]);
  const logs: unknown[][] = [];
  const oldConsole = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  try {
    process.env.TYPESAFE_LOG_LEVEL = "debug";
    process.env.TYPESAFE_BASE_URL = "https://example.invalid";
    process.env.TYPESAFE_API_KEY = "environment-key";
    for (const name of Object.keys(oldConsole) as (keyof typeof oldConsole)[])
      console[name] = (...args: unknown[]) => {
        logs.push(args);
      };
    const scorer = createJevScorer("settings-key", {
      fetch: async (url, init) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer settings-key",
        );
        return new Response(JSON.stringify(response()));
      },
    });
    assert.equal((await scorer.score(input)).kind, "ok");
    assert.equal(logs.length, 0);
  } finally {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
    Object.assign(console, oldConsole);
  }
});

test("mock輸送の正常結果とusage、事前・処理中abortを扱う", async () => {
  const scorer = createJevScorer("test-key", {
    fetch: async () =>
      new Response(JSON.stringify(response()), { status: 200 }),
  });
  assert.deepEqual(await scorer.score(input), {
    kind: "ok",
    result,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await scorer.score(input, controller.signal), {
    kind: "failed",
    reason: "aborted",
  });
  const during = new AbortController();
  const cancelling = createJevScorer("test-key", {
    fetch: async () => {
      during.abort();
      return new Response(JSON.stringify(response()));
    },
  });
  assert.deepEqual(await cancelling.score(input, during.signal), {
    kind: "failed",
    reason: "aborted",
  });
});

test("1ラウンド20件・同時2件以内とFIFO残りを保持する", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const items = Array.from({ length: 25 }, (_, i) => ({
    key: String(i),
    input,
  }));
  const round = await scoreAIRound(items, {
    score: async () => {
      active++;
      calls++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { kind: "ok", result };
    },
  });
  assert.equal(calls, 20);
  assert.equal(peak, 2);
  assert.equal(round.results.size, 20);
  assert.deepEqual(round.remaining, ["20", "21", "22", "23", "24"]);
});

test("429後に後続候補を送らず、abort世代の完了結果を残さない", async () => {
  let calls = 0;
  const items = Array.from({ length: 25 }, (_, i) => ({
    key: String(i),
    input,
  }));
  const rate = await scoreAIRound(items, {
    score: async () => {
      calls++;
      return { kind: "failed", reason: "rate" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(rate.stopped, "rate");
  assert.equal(rate.remaining.length, 23);
  const controller = new AbortController();
  const aborted = await scoreAIRound(
    items,
    {
      score: async () => {
        controller.abort();
        return { kind: "ok", result };
      },
    },
    controller.signal,
  );
  assert.equal(aborted.results.size, 0);
  assert.equal(aborted.stopped, "aborted");
});

test("認証エラー後は後続候補を送らず、未実行の候補を次のラウンドに残す", async () => {
  let calls = 0;
  const items = Array.from({ length: 25 }, (_, index) => ({
    key: String(index),
    input,
  }));
  const round = await scoreAIRound(items, {
    score: async () => {
      calls++;
      return { kind: "failed", reason: "auth" };
    },
  });
  assert.equal(round.stopped, "auth");
  assert.ok(calls <= 2);
  assert.equal(round.results.size, calls);
  assert.equal(round.remaining.length, 25 - calls);
  assert.deepEqual(
    round.remaining,
    items.slice(calls).map((item) => item.key),
  );
});

test("SDKは15秒で要求を中断し、タイムアウトを再試行しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const scorer = createJevScorer("test-key", {
    fetch: async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  });
  const pending = scorer.score(input);
  t.mock.timers.tick(14_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { kind: "failed", reason: "timeout" });
  assert.equal(calls, 1);
});

test("リアクションの本人を相対識別子にし、時間評価キャッシュは5分単位で失効する", () => {
  const prepared = prepareAIInput({
    ...input,
    messages: [
      {
        ...input.messages[0],
        reactions: [{ name: "+1", users: ["U1", "U3"] }],
      },
    ],
  });
  assert.deepEqual(prepared.state.messages[0].reactions, [
    { name: "+1", selfReacted: true, otherCount: 1 },
  ]);
  const near = { ...input, asOf: "201.000000" };
  const after = { ...input, asOf: "501.000000" };
  assert.equal(aiInputHash(input), aiInputHash(near));
  assert.notEqual(aiInputHash(input), aiInputHash(after));
});

test("表示名付きメンションでもプロフィール名を送らず相対化する", () => {
  const prepared = prepareAIInput({
    ...input,
    messages: [
      {
        ...input.messages[0],
        text: "<@U1|秘密の本名> <@U2|送信者本名> <@U3|第三者本名> 今日中にお願いします",
      },
    ],
  });
  assert.equal(
    prepared.state.messages[0].text,
    "@self @person1 @other 今日中にお願いします",
  );
  assert.ok(!JSON.stringify(prepared.state).includes("本名"));
});

test("反応ユーザー大量・JSONエスケープでも送信state全体16000文字以内、省略時要確認", () => {
  const users = Array.from({ length: 10000 }, (_, i) => `U${i}`);
  const prepared = prepareAIInput({
    ...input,
    messages: [{ ...input.messages[0], reactions: [{ name: "+1", users }] }],
  });
  assert.ok(JSON.stringify(prepared.state).length <= 16000);
  assert.equal(prepared.contextIncomplete, true);
  assert.equal(prepared.state.messages[0].reactions[0].otherCount, 9999);
  const escaped = prepareAIInput({
    ...input,
    messages: [{ ...input.messages[0], text: '"'.repeat(12000) }],
  });
  assert.ok(JSON.stringify(escaped.state).length <= 16000);
  assert.equal(escaped.contextIncomplete, true);
});
