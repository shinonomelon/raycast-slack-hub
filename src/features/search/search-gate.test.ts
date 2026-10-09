import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackApiError } from "../../slack/slack-api.ts";
const NOW = 1_759_560_000_000;
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

test("APIの時間切れは検索・既読取得を30秒止める", () => {
  assert.equal(SEARCH_TIMEOUT_MS, 15_000);
  assert.equal(LAST_READ_TIMEOUT_MS, 30_000);
  for (const classify of [classifySearchFailure, classifyLastReadFailure]) {
    const result = classify(new SlackApiError("timeout", "timeout"), NOW);
    assert.equal(result.kind, "timeout");
    assert.deepEqual(result.pause, {
      until: NOW + TIMEOUT_PAUSE_MS,
      cause: "timeout",
    });
  }
});
test("Retry-Afterの秒数だけ停止し、認証の失敗では停止期限を作らない", () => {
  for (const classify of [classifySearchFailure, classifyLastReadFailure]) {
    const result = classify(new SlackApiError("rate_limited", "429", 45), NOW);
    assert.equal(result.kind, "rate_limited");
    assert.equal(result.pause?.until, NOW + 45_000);
    const rejected = classify(
      new SlackApiError("api", "invalid_auth", undefined, "invalid_auth"),
      NOW,
    );
    assert.equal(rejected.kind, "error");
    assert.equal(rejected.pause, undefined);
  }
});
