import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyLastReadFailure,
  classifySearchFailure,
  decideSearch,
  isPaused,
  LAST_READ_TIMEOUT_MS,
  mergePause,
  MIN_SEARCH_INTERVAL_MS,
  parsePause,
  SEARCH_TIMEOUT_MS,
  searchDelay,
  serializePause,
  statusForSkipped,
  TIMEOUT_PAUSE_MS,
  type Pause,
} from "./search-gate.ts";
import type { CliResult } from "./types.ts";

const NOW = 1_759_560_000_000;

// 終了コード 1 で終わった slack-cli の結果。必要なところだけ上書きして使う
const failed = (
  stderr: string,
  overrides: Partial<CliResult> = {},
): CliResult => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr,
  timedOut: false,
  aborted: false,
  ...overrides,
});

// ---- 検索するかの判断 ---------------------------------------------------------------

test("空と1文字は検索しない。2文字からは検索する（前後の空白は数えない）", () => {
  assert.deepEqual(decideSearch("", undefined, NOW), {
    search: false,
    reason: "empty",
  });
  assert.deepEqual(decideSearch("   ", undefined, NOW), {
    search: false,
    reason: "empty",
  });
  assert.deepEqual(decideSearch("請", undefined, NOW), {
    search: false,
    reason: "too-short",
  });
  assert.deepEqual(decideSearch("  a ", undefined, NOW), {
    search: false,
    reason: "too-short",
  });
  assert.deepEqual(decideSearch("請求", undefined, NOW), { search: true });
  // 絞り込みだけの検索式（そのチャンネルの新しい投稿を見る）は2文字以上なので検索する
  assert.deepEqual(decideSearch("in:<#C1>", undefined, NOW), { search: true });
});

test("基本多言語面の外の漢字は、1文字と数える", () => {
  // 𠮷（U+20BB7）は JavaScript の length では 2 だが、1文字
  assert.equal("𠮷".length, 2);
  assert.deepEqual(decideSearch("𠮷", undefined, NOW), {
    search: false,
    reason: "too-short",
  });
  assert.deepEqual(decideSearch("𠮷野", undefined, NOW), { search: true });
});

test("時間切れの秒数は15秒で、時間切れのあと30秒は検索しない", () => {
  assert.equal(SEARCH_TIMEOUT_MS, 15_000);
  assert.equal(TIMEOUT_PAUSE_MS, 30_000);

  const failure = classifySearchFailure(
    {
      code: null,
      signal: "SIGTERM",
      stderr: "",
      timedOut: true,
      aborted: false,
    },
    NOW,
  );
  assert.equal(failure?.kind, "timeout");
  assert.deepEqual(failure?.pause, { until: NOW + 30_000, cause: "timeout" });

  // 期限の内側（29.999 秒後まで）は検索しない。期限の時刻から検索する
  assert.equal(decideSearch("請求", failure?.pause, NOW).search, false);
  assert.equal(
    decideSearch("請求", failure?.pause, NOW + 29_999).search,
    false,
  );
  assert.equal(decideSearch("請求", failure?.pause, NOW + 30_000).search, true);
});

test("回数制限（標準エラーに「you may retry this request in N seconds」）は、N 秒だけ検索しない", () => {
  const failure = classifySearchFailure(
    failed(
      "✗ Error: A rate-limit has been reached, you may retry this request in 45 seconds\n",
    ),
    NOW,
  );
  assert.equal(failure?.kind, "rate_limited");
  assert.equal(
    failure?.message,
    "A rate-limit has been reached, you may retry this request in 45 seconds",
  );
  assert.deepEqual(failure?.pause, {
    until: NOW + 45_000,
    cause: "rate_limited",
  });
  assert.equal(
    decideSearch("請求", failure?.pause, NOW + 44_999).search,
    false,
  );
  assert.equal(decideSearch("請求", failure?.pause, NOW + 45_000).search, true);
});

test("回数制限の文は、色の制御文字が混ざっていても、1秒（単数）でも読む", () => {
  const colored = classifySearchFailure(
    failed(
      "\u001b[31m✗ Error:\u001b[39m A rate-limit has been reached, you may retry this request in 30 seconds\n",
    ),
    NOW,
  );
  assert.equal(colored?.pause?.until, NOW + 30_000);

  const one = classifySearchFailure(
    failed("✗ Error: ..., you may retry this request in 1 second\n"),
    NOW,
  );
  assert.equal(one?.pause?.until, NOW + 1_000);
});

test("それ以外の失敗は止めず、エラー文を返す（invalid_cursor・形式の誤り・認証の失敗）", () => {
  const apiError = classifySearchFailure(
    failed("✗ Error: An API error occurred: invalid_cursor\n"),
    NOW,
  );
  assert.deepEqual(apiError, {
    kind: "error",
    message: "An API error occurred: invalid_cursor",
  });
  // 止めない失敗のあとも、すぐ検索できる
  assert.equal(decideSearch("請求", apiError?.pause, NOW).search, true);

  // 引数の検証エラー（commander）は先頭に ✗ が付かない
  assert.equal(
    classifySearchFailure(
      failed(
        "Error: Invalid format 'xml'. Must be one of: table, simple, json, raw\n",
      ),
      NOW,
    )?.pause,
    undefined,
  );
  assert.equal(
    classifySearchFailure(
      failed("✗ Error: An API error occurred: token_expired\n"),
      NOW,
    )?.kind,
    "error",
  );
  // 回数制限の「rate limit」（空白）の文は、待つ秒数が無いので止めない（文の有無では見分けない）
  assert.equal(
    classifySearchFailure(
      failed("✗ Error: A rate limit was exceeded (retry-after: 30)\n"),
      NOW,
    )?.pause,
    undefined,
  );
});

test("中断（新しい入力で止めた）と、成功は、失敗として扱わない。シグナルで止められたものは、止めずにエラーにする", () => {
  assert.equal(
    classifySearchFailure(
      failed("", { code: null, signal: "SIGTERM", aborted: true }),
      NOW,
    ),
    undefined,
  );
  assert.equal(classifySearchFailure(failed("", { code: 0 }), NOW), undefined);
  const killed = classifySearchFailure(
    failed("", { code: null, signal: "SIGKILL" }),
    NOW,
  );
  assert.equal(killed?.kind, "error");
  assert.equal(killed?.pause, undefined);
  assert.ok(killed?.message.includes("SIGKILL"));
});

test("検索どうしの間隔は最短1秒。前の検索から1秒たっていれば待たない", () => {
  assert.equal(MIN_SEARCH_INTERVAL_MS, 1_000);
  assert.equal(searchDelay(NOW, NOW), 1_000);
  assert.equal(searchDelay(NOW, NOW + 400), 600);
  assert.equal(searchDelay(NOW, NOW + 1_000), 0);
  assert.equal(searchDelay(NOW, NOW + 5_000), 0);
  // まだ一度も検索していない
  assert.equal(searchDelay(0, NOW), 0);
});

// ---- 止める期限の保存 ---------------------------------------------------------------

test("保存した止める期限は、そのまま読み戻せる。過ぎた期限・壊れた値・形が違う値は、止めない", () => {
  const pause: Pause = { until: NOW + 30_000, cause: "rate_limited" };
  assert.deepEqual(parsePause(serializePause(pause), NOW), pause);

  // 保存が無い
  assert.equal(parsePause(undefined, NOW), undefined);
  // もう過ぎた（期限の時刻ちょうども過ぎたものとして扱う）
  assert.equal(
    parsePause(serializePause({ ...pause, until: NOW }), NOW),
    undefined,
  );
  assert.equal(
    parsePause(serializePause({ ...pause, until: NOW - 1 }), NOW),
    undefined,
  );
  // 壊れた値
  assert.equal(parsePause("{ 壊れた", NOW), undefined);
  assert.equal(parsePause("", NOW), undefined);
  assert.equal(parsePause("null", NOW), undefined);
  assert.equal(parsePause("123", NOW), undefined);
  assert.equal(
    parsePause('{"until":"明日","cause":"timeout"}', NOW),
    undefined,
  );
  assert.equal(parsePause('{"until":null,"cause":"timeout"}', NOW), undefined);
  assert.equal(parsePause(`{"until":${NOW + 1000}}`, NOW), undefined);
  assert.equal(
    parsePause(`{"until":${NOW + 1000},"cause":"さぼり"}`, NOW),
    undefined,
  );
});

test("止める期限を延ばすときは、遅いほうを使う（短い期限で、止めていた期間を縮めない）", () => {
  const long: Pause = { until: NOW + 60_000, cause: "rate_limited" };
  const short: Pause = { until: NOW + 30_000, cause: "timeout" };
  assert.deepEqual(mergePause(long, short), long);
  assert.deepEqual(mergePause(short, long), long);
  assert.deepEqual(mergePause(undefined, short), short);
});

// ---- 検索の記録 ---------------------------------------------------------------------

// 検索しないと判断して、その記録を作る
function skippedStatus(query: string, pause?: Pause) {
  const decision = decideSearch(query, pause, NOW);
  if (decision.search) throw new Error("検索しない判断のはず");
  return statusForSkipped(query, decision);
}

test("検索しなかった判断は、その検索式つきの記録になる（画面が、いまの検索欄の分かを見分けるため）", () => {
  assert.deepEqual(skippedStatus("請"), {
    kind: "skipped",
    query: "請",
    reason: "too-short",
  });
  assert.deepEqual(skippedStatus(""), {
    kind: "skipped",
    query: "",
    reason: "empty",
  });
  const pause: Pause = { until: NOW + 1000, cause: "timeout" };
  assert.deepEqual(skippedStatus("請求", pause), {
    kind: "paused",
    query: "請求",
    pause,
  });
});

// ---- 既読位置の取得の失敗（③） ------------------------------------------------------

test("止める期限の内側かは、期限の時刻を含まない。期限が無ければ止めない", () => {
  const pause: Pause = { until: NOW + 30_000, cause: "timeout" };
  assert.equal(isPaused(undefined, NOW), false);
  assert.equal(isPaused(pause, NOW), true);
  assert.equal(isPaused(pause, NOW + 29_999), true);
  assert.equal(isPaused(pause, NOW + 30_000), false);
});

test("既読位置の取得の時間切れは30秒で、時間切れのあと30秒は取り直さない", () => {
  assert.equal(LAST_READ_TIMEOUT_MS, 30_000);

  const failure = classifyLastReadFailure(
    {
      code: null,
      signal: "SIGTERM",
      stderr: "",
      timedOut: true,
      aborted: false,
    },
    NOW,
  );
  assert.equal(failure?.kind, "timeout");
  assert.deepEqual(failure?.pause, { until: NOW + 30_000, cause: "timeout" });
  // 検索の時間切れの文ではなく、既読位置の取得の文
  assert.ok(failure?.message.includes("既読位置"));
  assert.equal(isPaused(failure?.pause, NOW + 29_999), true);
  assert.equal(isPaused(failure?.pause, NOW + 30_000), false);
});

test("既読位置の取得の全体の失敗：待つ秒数があればその秒数、認証の失敗など（秒数の無い失敗）は止めない", () => {
  const limited = classifyLastReadFailure(
    failed(
      "✗ Error: A rate-limit has been reached, you may retry this request in 45 seconds\n",
    ),
    NOW,
  );
  assert.equal(limited?.kind, "rate_limited");
  assert.deepEqual(limited?.pause, {
    until: NOW + 45_000,
    cause: "rate_limited",
  });

  // 認証の失敗（token_expired など）は、全体の失敗。止めずに、エラー文を返す
  for (const text of [
    "✗ Error: An API error occurred: token_expired\n",
    "✗ Error: An API error occurred: invalid_auth\n",
    "Error: Invalid format 'xml'. Must be one of: table, simple, json\n",
  ]) {
    const failure = classifyLastReadFailure(failed(text), NOW);
    assert.equal(failure?.kind, "error", text);
    assert.equal(failure?.pause, undefined, text);
  }
  assert.equal(
    classifyLastReadFailure(
      failed("✗ Error: An API error occurred: token_expired\n"),
      NOW,
    )?.message,
    "An API error occurred: token_expired",
  );
});

test("既読位置の取得：終了コード 0 は、標準エラーに理由の行があっても失敗でない。中断も失敗として扱わない。シグナルで止められたら止めずにエラー", () => {
  assert.equal(
    classifyLastReadFailure(
      failed("⚠ no_last_read: C2\n✗ Error: 読み取れない会話があります\n", {
        code: 0,
      }),
      NOW,
    ),
    undefined,
  );
  assert.equal(
    classifyLastReadFailure(
      failed("", { code: null, signal: "SIGTERM", aborted: true }),
      NOW,
    ),
    undefined,
  );
  const killed = classifyLastReadFailure(
    failed("", { code: null, signal: "SIGKILL" }),
    NOW,
  );
  assert.equal(killed?.kind, "error");
  assert.equal(killed?.pause, undefined);
  assert.ok(killed?.message.includes("SIGKILL"));
});
