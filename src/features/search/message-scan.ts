import { compareTs, type Hit } from "../../slack/hits.ts";
import type { SearchPageOutcome } from "../../slack/slack.ts";
import type { MessageSearchPlan } from "../search-scope/search-plan.ts";
import type { Pause, SearchFailure } from "./search-gate.ts";

export const MESSAGE_SEARCH_CALLS = 4;
export const MESSAGE_SEARCH_ROUND_MS = 60_000;
export const MESSAGE_SEARCH_LIMIT = 400;
export type MessageScanSnapshot = {
  asOf: string;
  hits: Hit[];
  pendingCount: number;
  completedSearches: number;
  totalSearches: number;
  calls: number;
  capped: boolean;
  omittedCount: number;
  partial: boolean;
  failedQueries: string[];
  pausedUntil: number;
  failure?: SearchFailure;
};
export function messagePlanKey(
  expression: string,
  plan?: MessageSearchPlan,
): string {
  return JSON.stringify([
    expression,
    plan?.scope.fingerprint ?? "legacy",
    plan?.queries ?? [expression],
    plan?.canSearch ?? true,
    plan?.conflicts ?? [],
  ]);
}
export type MessageScanPorts = {
  search: (
    query: string,
    page: number,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<SearchPageOutcome>;
  readPause: () => Pause | undefined;
  writePause: (pause: Pause) => Pause;
  now?: () => number;
};
// 再開中も同じ基準時刻を使い、チャンネルの1ページ目を先に回す。
export function createMessageScan(
  expression: string,
  plan: MessageSearchPlan | undefined,
  ports: MessageScanPorts,
) {
  const now = ports.now ?? Date.now;
  const baseline = now();
  const asOf = `${Math.floor(baseline / 1000)}.${String(baseline % 1000).padStart(3, "0")}000`;
  // Slackの日付境界に時差の余裕を持たせ、厳密な時刻境界は結果側でも検証する。
  const beforeDate = new Date(baseline + 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const queries = [...new Set(plan?.queries ?? [expression])];
  const tasks = queries.map((query, index) => ({ query, index, page: 1 }));
  const hits = new Map<string, Hit>();
  const failed = new Map<string, SearchFailure>();
  const completed = new Set<number>();
  let calls = 0,
    capped = false,
    omittedCount = 0,
    pausedUntil = 0,
    busy = false;
  let lastFailure: SearchFailure | undefined;
  const snapshot = (): MessageScanSnapshot => ({
    asOf,
    hits: [...hits.values()].sort(
      (a, b) =>
        compareTs(b.ts, a.ts) ||
        a.channelId.localeCompare(b.channelId) ||
        a.ts.localeCompare(b.ts),
    ),
    pendingCount: tasks.length,
    completedSearches: completed.size,
    totalSearches: queries.length,
    calls,
    capped,
    omittedCount,
    partial: tasks.length > 0 || capped || failed.size > 0,
    failedQueries: [...failed.keys()],
    pausedUntil,
    failure: lastFailure,
  });
  const acceptable = (hit: Hit) =>
    /^\d+\.\d+$/.test(hit.ts) &&
    compareTs(hit.ts, asOf) <= 0 &&
    (!plan ||
      ((plan.scope.channelIds === "all" ||
        ((hit.channelKind === "channel" || hit.channelKind === "private") &&
          plan.scope.channelIds.includes(hit.channelId))) &&
        (!plan.scope.senderId || hit.userId === plan.scope.senderId)));
  async function run(signal: AbortSignal): Promise<MessageScanSnapshot> {
    if (busy || signal.aborted || (plan && !plan.canSearch)) return snapshot();
    const pause = ports.readPause();
    if (pause && pause.until > now()) {
      pausedUntil = pause.until;
      return snapshot();
    }
    pausedUntil = 0;
    lastFailure = undefined;
    busy = true;
    const started = now();
    let roundCalls = 0;
    const retry: typeof tasks = [];
    try {
      while (
        tasks.length &&
        roundCalls < MESSAGE_SEARCH_CALLS &&
        now() - started < MESSAGE_SEARCH_ROUND_MS &&
        !signal.aborted
      ) {
        const currentPause = ports.readPause();
        if (currentPause && currentPause.until > now()) {
          pausedUntil = currentPause.until;
          break;
        }
        const task = tasks.shift()!;
        const timeoutMs = Math.min(
          15_000,
          MESSAGE_SEARCH_ROUND_MS - (now() - started),
        );
        calls++;
        roundCalls++;
        let outcome: SearchPageOutcome;
        try {
          outcome = await ports.search(
            `${task.query} before:${beforeDate}`,
            task.page,
            signal,
            timeoutMs,
          );
        } catch {
          outcome = {
            kind: "failed",
            failure: {
              kind: "error",
              message: "検索に失敗しました。続きを取得で再試行できます",
            },
          };
        }
        if (signal.aborted || outcome.kind === "aborted") {
          tasks.unshift(task);
          break;
        }
        if (outcome.kind === "failed") {
          failed.set(task.query, outcome.failure);
          lastFailure = outcome.failure;
          if (outcome.failure.pause) {
            pausedUntil = ports.writePause(outcome.failure.pause).until;
            tasks.unshift(task);
            break;
          }
          retry.push(task);
          continue;
        }
        failed.delete(task.query);
        const ordered = [...outcome.hits]
          .filter(acceptable)
          .sort(
            (a, b) =>
              compareTs(b.ts, a.ts) ||
              a.channelId.localeCompare(b.channelId) ||
              a.ts.localeCompare(b.ts),
          );
        for (const hit of ordered) {
          const key = `${hit.channelId}:${hit.ts}`;
          if (hits.has(key)) {
            hits.set(key, hit);
            continue;
          }
          if (hits.size >= MESSAGE_SEARCH_LIMIT) {
            omittedCount++;
            capped = true;
            continue;
          }
          hits.set(key, hit);
        }
        if (outcome.capped && task.page < 2) tasks.push({ ...task, page: 2 });
        else {
          completed.add(task.index);
          if (outcome.capped) capped = true;
        }
        if (hits.size >= MESSAGE_SEARCH_LIMIT) {
          if (tasks.length || retry.length) capped = true;
          tasks.length = 0;
          retry.length = 0;
          break;
        }
      }
      tasks.push(...retry);
      return snapshot();
    } finally {
      busy = false;
    }
  }
  return { snapshot, run };
}
