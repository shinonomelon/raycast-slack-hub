import { parseJson } from "./cli-output.ts";
import { normalizeMatch, type Hit } from "./hits.ts";
import { toPeople, type RawUser } from "./people.ts";
import {
  classifyLastReadFailure,
  classifySearchFailure,
  LAST_READ_TIMEOUT_MS,
  SEARCH_TIMEOUT_MS,
  type LastReadFailure,
  type SearchFailure,
} from "./search-gate.ts";
import { failureMessage, type Run } from "./slack-cli.ts";
import { LAST_READ_BUDGET } from "./triage.ts";
import type {
  Conversation,
  LastReadReason,
  LastReadRow,
  Person,
} from "./types.ts";

// 一覧はページ送りが続くので長めに待つ（users は全件で17秒ほどかかる）
const LIST_TIMEOUT_MS = 120_000;
// slack-cli は --limit で指定した件数までページ送りする。全件取りたいので十分大きくする
const NO_LIMIT = "100000";

// 一覧を取る。0 以外で終わったときと時間切れのときは Error にして、画面のトーストに出す。
// 画面を閉じても止めない（人の取得は25秒ほどかかり、途中で止めると結果を捨てることになるため）。
// slack-cli を呼ぶ関数（run）は、Raycast の設定を読む側が渡す（このファイルは Raycast を読み込まない）
async function listJson<T>(run: Run, args: string[], fallback: T): Promise<T> {
  const result = await run(args, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(failureMessage(result, LIST_TIMEOUT_MS));
  }
  return parseJson(result.stdout, fallback);
}

// 公開・非公開チャンネルとグループDMを取る。アーカイブ済みは slack-cli の既定で除かれる
export async function listConversations(run: Run): Promise<Conversation[]> {
  const types = ["public", "private", "mpim"] as const;
  const results = await Promise.all(
    types.map(async (type) => {
      type Raw = { id: string; name: string };
      const rows = await listJson<Raw[]>(
        run,
        ["channels", "--type", type, "--limit", NO_LIMIT, "--format", "json"],
        [],
      );
      return rows.map((c) => ({ id: c.id, name: c.name, type }));
    }),
  );
  return results.flat();
}

// 削除済みを除いた人を取る（ボットは isBot を付けて残す。一覧の行に出す人とメンションの候補は people.ts で分ける）。
// キャッシュに載せるので、プロフィール全体ではなく表示と検索に要る項目だけ残す
export async function listPeople(run: Run): Promise<Person[]> {
  const raw = await listJson<RawUser[]>(
    run,
    ["users", "list", "--limit", NO_LIMIT, "--format", "json"],
    [],
  );
  return toPeople(raw);
}

// 自分が参加している公開チャンネルの ID を取る。非公開チャンネルとグループDMは
// 参加しているものしか一覧に出ないので問い合わせない
export async function listJoinedChannelIds(run: Run): Promise<string[]> {
  const rows = await listJson<{ id: string }[]>(
    run,
    [
      "channels",
      "--type",
      "public",
      "--member-only",
      "--limit",
      NO_LIMIT,
      "--format",
      "json",
    ],
    [],
  );
  return rows.map((c) => c.id);
}

// ---- メッセージの検索 -----------------------------------------------------------------

// 1ページ（新しい順に100件）だけ取る。古いものは、語や in: を足して絞ってもらう
const SEARCH_PAGE_SIZE = 100;

// slack-cli の search に渡す引数。raw は Slack の matches を整形せずに出す形式で、
// 会話の ID と種類・送信者の ID・スレッドの親が分かる（--format json はそれらを捨てる）。
// raw のときだけ、回数制限に当たっても待たず、待つ秒数を載せたエラーですぐ失敗する。
// 並びは新しい順が既定。sortDir に "asc" を渡すと古い順（件数不明の会話を、既読位置の日から確かめるとき）。
// 省略したときの引数は、これまでと同じ
export function searchArgs(query: string, sortDir?: "asc" | "desc"): string[] {
  return [
    "search",
    "-q",
    query,
    "--sort",
    "timestamp",
    "-n",
    String(SEARCH_PAGE_SIZE),
    "--format",
    "raw",
    ...(sortDir === "asc" ? ["--sort-dir", "asc"] : []),
  ];
}

export type SearchOutcome =
  | { kind: "ok"; hits: Hit[] }
  // 時間切れ・回数制限・Slack が断ったエラーなど。止める期限があれば failure.pause に入る
  | { kind: "failed"; failure: SearchFailure }
  // 呼び出し側が中断した（新しい入力が来た）。結果は使わない
  | { kind: "aborted" };

// 検索結果1ページ。capped は、件数の上限で切れた（Slack の総件数が、取れた件数より多い）こと。
// お気に入りの未読を数えるとき、切れた会話の件数は下限になる
export type SearchPageOutcome =
  | { kind: "ok"; hits: Hit[]; capped: boolean }
  | { kind: "failed"; failure: SearchFailure }
  | { kind: "aborted" };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const failure = (message: string): SearchPageOutcome => ({
  kind: "failed",
  failure: { kind: "error", message },
});

// メッセージを検索して Hit にし、件数の上限で切れたかも返す。投げない（失敗は結果で返す）。
// 新しい入力が来たら signal で中断する（プロセスグループごと止める）。15秒で打ち切る
export async function searchPage(
  query: string,
  options: {
    // slack-cli を呼ぶ関数。テストでは差し替える
    run: Run;
    // 自分のユーザー ID。自分宛て（<@自分>）のメッセージかの判定に使う
    selfId: string;
    signal?: AbortSignal;
    now?: () => number;
    sortDir?: "asc" | "desc";
  },
): Promise<SearchPageOutcome> {
  const { signal, run, selfId, now = Date.now, sortDir } = options;
  let result;
  try {
    result = await run(searchArgs(query, sortDir), {
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    // 起動できなかった・出力が上限を超えたなど
    if (signal?.aborted) return { kind: "aborted" };
    return failure(errorMessage(error));
  }
  if (result.aborted) return { kind: "aborted" };
  const classified = classifySearchFailure(result, now());
  if (classified) return { kind: "failed", failure: classified };

  let raw: { matches?: unknown; totalCount?: unknown } | undefined;
  try {
    raw = parseJson<{ matches?: unknown; totalCount?: unknown } | undefined>(
      result.stdout,
      undefined,
    );
  } catch {
    return failure("検索結果を読み取れませんでした（JSON ではありません）");
  }
  if (!raw || !Array.isArray(raw.matches)) {
    return failure("検索結果を読み取れませんでした（matches がありません）");
  }
  const hits = raw.matches
    .map((match) => normalizeMatch(match, selfId))
    .filter((hit): hit is Hit => hit !== undefined);
  // 総件数が分からないときは、切れていないものとして扱う。読めなかった match があっても、件数は slack-cli が返した数で比べる
  const total =
    typeof raw.totalCount === "number" && Number.isFinite(raw.totalCount)
      ? raw.totalCount
      : raw.matches.length;
  return { kind: "ok", hits, capped: total > raw.matches.length };
}

// メッセージを検索して Hit にする（件数の上限で切れたかは見ない）。投げない（失敗は結果で返す）。
// 新しい入力が来たら signal で中断する（プロセスグループごと止める）。15秒で打ち切る
export async function searchMessages(
  query: string,
  options: {
    run: Run;
    selfId: string;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<SearchOutcome> {
  const outcome = await searchPage(query, options);
  return outcome.kind === "ok" ? { kind: "ok", hits: outcome.hits } : outcome;
}

// ---- 既読位置の取得 -------------------------------------------------------------------

// Slack の会話 ID（C…・G…・D…）の形。先頭が - の値をオプションと取り違えないためにも、この形だけを通す
const CONVERSATION_ID = /^[A-Z0-9]+$/;
// Slack の ts（秒10桁・小数点・マイクロ秒6桁）
const SLACK_TS = /^\d{10}\.\d{6}$/;
const LAST_READ_REASONS: ReadonlySet<string> = new Set<LastReadReason>([
  "no_last_read",
  "not_visible",
  "rate_limited",
  "error",
]);

// slack-cli の channel last-read に渡す引数。会話 ID を複数まとめて渡し、会話ごとの既読位置を JSON で受け取る。
// 再試行はせず、回数制限は待たずに行の reason（rate_limited・retryAfter）で返る
export function lastReadArgs(ids: readonly string[]): string[] {
  return ["channel", "last-read", ...ids, "--format", "json"];
}

export type LastReadsOutcome =
  | { kind: "ok"; rows: LastReadRow[] }
  // 全体の失敗（時間切れ・認証の失敗・出力が読めないなど）。止める期限があれば failure.pause に入る
  | { kind: "failed"; failure: LastReadFailure };

const lastReadFailure = (message: string): LastReadsOutcome => ({
  kind: "failed",
  failure: { kind: "error", message },
});

// channel last-read の出力の1行を読む。会話 ID が読めない行は捨てる。
// 形の合わない値（知らない理由・ts の形でない値・値の無い成功）は error にして、保存せず次に取り直す
function toLastReadRow(item: unknown): LastReadRow | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { channelId, lastRead, reason, retryAfter } = item as Record<
    string,
    unknown
  >;
  if (typeof channelId !== "string") return undefined;
  if (reason === null) {
    return typeof lastRead === "string" && SLACK_TS.test(lastRead)
      ? { channelId, lastRead, reason: null }
      : { channelId, lastRead: null, reason: "error" };
  }
  if (typeof reason !== "string" || !LAST_READ_REASONS.has(reason)) {
    return { channelId, lastRead: null, reason: "error" };
  }
  const known = reason as LastReadReason;
  return known === "rate_limited" &&
    typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
    ? { channelId, lastRead: null, reason: known, retryAfter }
    : { channelId, lastRead: null, reason: known };
}

// 会話ごとの既読位置を、1回の slack-cli の呼び出しでまとめて取る。投げない（失敗は結果で返す）。
// 1回に取るのは20会話まで（重複と、会話 ID の形でないものは除く）。取る会話が無ければ、slack-cli を起動しない。
// 30秒で打ち切る。呼び出しは中断しない（取り直しの途中でも最後まで行い、結果は保存する）。
// 止める期限（回数制限・時間切れ）の保存は呼び出し側が行う。この関数は Raycast を読み込まない
export async function getLastReads(
  ids: readonly string[],
  options: { run: Run; now?: () => number },
): Promise<LastReadsOutcome> {
  const { run, now = Date.now } = options;
  const requested = [...new Set(ids)]
    .filter((id) => CONVERSATION_ID.test(id))
    .slice(0, LAST_READ_BUDGET);
  if (requested.length === 0) return { kind: "ok", rows: [] };

  let result;
  try {
    result = await run(lastReadArgs(requested), {
      timeoutMs: LAST_READ_TIMEOUT_MS,
    });
  } catch (error) {
    // 起動できなかった・出力が上限を超えたなど
    return lastReadFailure(errorMessage(error));
  }
  if (result.aborted) return lastReadFailure("既読位置の取得を中断しました");
  const classified = classifyLastReadFailure(result, now());
  if (classified) return { kind: "failed", failure: classified };

  let json: unknown;
  try {
    json = parseJson<unknown>(result.stdout, undefined);
  } catch {
    return lastReadFailure(
      "既読位置を読み取れませんでした（JSON ではありません）",
    );
  }
  if (!Array.isArray(json)) {
    return lastReadFailure(
      "既読位置を読み取れませんでした（配列ではありません）",
    );
  }
  // 頼んでいない会話の行は使わない。同じ会話が複数あれば、先のもの
  const wanted = new Set(requested);
  const rows = new Map<string, LastReadRow>();
  for (const item of json) {
    const row = toLastReadRow(item);
    if (row && wanted.has(row.channelId) && !rows.has(row.channelId)) {
      rows.set(row.channelId, row);
    }
  }
  return { kind: "ok", rows: [...rows.values()] };
}
