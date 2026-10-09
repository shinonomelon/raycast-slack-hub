// 検索の回し方の判断。@raycast/api を読み込まない純粋な部品で、node のテストから動かせる。
// 止める期限の保存は gate-store.ts に分ける（Raycast の Cache を値として読むため、テストでは読み込めない）。
//
// Slack の検索は回数制限があり、同じトークンを使うほかの仕組み（Open Channel の裏の更新や monitoring など）と枠を分け合う。
// 打つたびに検索する画面が、枠を使い切らないよう、検索するかの判断と、失敗したあとに止める期限を、ここに集める
import { SlackApiError } from "../../slack/slack-api.ts";

// 止める期限は、Slack の API の種類ごとに別々に持つ（回数制限は API の種類ごとに数えられるため）。
// search は検索（search.messages）、last-read は既読位置の取得（③で使う）
export type GateKind = "search" | "last-read";

// 検索式がこの長さより短いときは検索しない（文字数はコードポイントで数える。基本多言語面の外の漢字や絵文字も1文字）
export const MIN_QUERY_LENGTH = 2;
// 検索は15秒で打ち切る
export const SEARCH_TIMEOUT_MS = 15_000;
// 時間切れのあと、この時間は次の検索を止める
export const TIMEOUT_PAUSE_MS = 30_000;
// 既読位置の取得（会話ごとの既読位置取得）は30秒で打ち切る。1回で最大20会話をまとめて取り、再試行はしない。
// 時間切れのあとは、検索と同じく30秒、既読位置の取得を止める（TIMEOUT_PAUSE_MS）
export const LAST_READ_TIMEOUT_MS = 30_000;
// 打ち終えてから検索するまでの待ち時間と、検索どうしの最短の間隔
export const DEBOUNCE_MS = 500;
export const MIN_SEARCH_INTERVAL_MS = 1_000;

// 検索を止めている理由。時間切れか、Slack の回数制限
export type PauseCause = "timeout" | "rate_limited";

// 次の検索を止める期限（この時刻まで検索しない）。epoch ミリ秒
export type Pause = { until: number; cause: PauseCause };

export type SearchDecision =
  | { search: true }
  | { search: false; reason: "empty" | "too-short" }
  | { search: false; reason: "paused"; pause: Pause };

// 止める期限の内側か（期限の時刻は含まない）。検索と既読位置の取得が、同じ決め方を使う
export function isPaused(
  pause: Pause | undefined,
  now: number,
): pause is Pause {
  return pause !== undefined && now < pause.until;
}

// 検索するかを決める。空と1文字は検索しない。止める期限の内側（期限の時刻は含まない）も検索しない
export function decideSearch(
  query: string,
  pause: Pause | undefined,
  now: number,
): SearchDecision {
  const length = Array.from(query.trim()).length;
  if (length === 0) return { search: false, reason: "empty" };
  if (length < MIN_QUERY_LENGTH) return { search: false, reason: "too-short" };
  if (isPaused(pause, now)) {
    return { search: false, reason: "paused", pause };
  }
  return { search: true };
}

// 前の検索を始めてから、最短の間隔があくまでの待ち時間
export function searchDelay(lastStartedAt: number, now: number): number {
  return Math.max(0, lastStartedAt + MIN_SEARCH_INTERVAL_MS - now);
}

export type SearchFailure = {
  kind: "timeout" | "rate_limited" | "error";
  // 行に出す文。Slack API のエラー文か、時間切れで止めたこと
  message: string;
  // 次の検索を止める期限。止めない失敗には付かない
  pause?: Pause;
};

export type LastReadFailure = SearchFailure;
function classifyApiFailure(
  error: unknown,
  now: number,
  label: string,
): SearchFailure {
  if (error instanceof SlackApiError && error.kind === "timeout")
    return {
      kind: "timeout",
      message: `${label}が時間切れになりました`,
      pause: { until: now + TIMEOUT_PAUSE_MS, cause: "timeout" },
    };
  if (error instanceof SlackApiError && error.kind === "rate_limited")
    return {
      kind: "rate_limited",
      message: error.message,
      pause: {
        until: now + (error.retryAfter ?? 60) * 1000,
        cause: "rate_limited",
      },
    };
  return {
    kind: "error",
    message:
      error instanceof Error
        ? error.message
        : "Slack APIへの問い合わせに失敗しました",
  };
}
export const classifySearchFailure = (
  error: unknown,
  now: number,
): SearchFailure => classifyApiFailure(error, now, "検索");
export const classifyLastReadFailure = (
  error: unknown,
  now: number,
): LastReadFailure => classifyApiFailure(error, now, "既読位置の取得");

// 前の期限があれば、遅いほうを使う（短い期限で、止めていた期間を縮めない）
export function mergePause(current: Pause | undefined, next: Pause): Pause {
  return current && current.until > next.until ? current : next;
}

// 保存した値から止める期限を読む。壊れた値・形が違う値・もう過ぎた期限は、止めない（undefined）
export function parsePause(
  raw: string | undefined,
  now: number,
): Pause | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { until, cause } = value as Record<string, unknown>;
  if (typeof until !== "number" || !Number.isFinite(until) || until <= now) {
    return undefined;
  }
  if (cause !== "timeout" && cause !== "rate_limited") return undefined;
  return { until, cause };
}

export function serializePause(pause: Pause): string {
  return JSON.stringify(pause);
}

// 検索の判断と結果の記録。検索式つきで持つので、画面は「いまの検索欄の結果か」を見分けられる
export type SearchStatus =
  // 検索して、結果を受け取った
  | { kind: "ok"; query: string }
  // 検索しなかった（空・1文字）
  | { kind: "skipped"; query: string; reason: "empty" | "too-short" }
  // 止めている（時間切れ・回数制限のあと）。検索しなかった
  | { kind: "paused"; query: string; pause: Pause }
  // 失敗した（止めない失敗）
  | { kind: "failed"; query: string; message: string };

// 検索しないと決めたときの記録
export function statusForSkipped(
  query: string,
  decision: Extract<SearchDecision, { search: false }>,
): SearchStatus {
  return decision.reason === "paused"
    ? { kind: "paused", query, pause: decision.pause }
    : { kind: "skipped", query, reason: decision.reason };
}
