import { createReplySearchPlan } from "../search-scope/search-plan.ts";
import { scopeFingerprint, type ResolvedScope } from "../search-scope/model.ts";
import {
  object,
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiParams,
} from "../../slack/slack-api.ts";
import type { Identity } from "../../slack/identity.ts";
import { randomUUID } from "node:crypto";
import {
  candidateFromMatch,
  checkReply,
  mergeCandidates,
  rawMessage,
  slackTs,
  sortReplyCandidates,
  uniqueMessages,
  type RawMessage,
  type ReplyCandidate,
  type ReplyEvidence,
} from "./reply-priority.ts";

export type ReplyScanTask = {
  key: string;
  kind: "root" | "history" | "replies";
  cursor?: string;
  seen: string[];
  messages: RawMessage[];
  unreadable?: boolean;
};
export type ReplyScanCheckpoint = {
  version: 2;
  scope: ResolvedScope;
  plan: string[];
  scanId: string;
  days: 1 | 7;
  snapshot: ReplyScanSnapshot;
  started: boolean;
  queue: ReplyScanTask[];
  searches: { query: string; page: number }[];
};
export type ReplyScanSnapshot = {
  candidates: ReplyCandidate[];
  asOf: string;
  since: string;
  pendingCount: number;
  pausedUntil: number;
  searchCapped: boolean;
  searchIncomplete: boolean;
  omittedCount?: number;
  displayLimitReached?: boolean;
  failedQueries?: string[];
  calls: {
    search: number;
    history: number;
    replies: number;
    auth: number;
    permalink: number;
  };
};
export type ReplyScanPorts = {
  api: ApiCall;
  scope?: ResolvedScope;
  knownBotIds?: ReadonlySet<string>;
  identity: Pick<Identity, "teamId" | "userId">;
  now?: () => number;
  signal?: AbortSignal;
  loadPause?: () => number;
  savePause?: (until: number) => void;
  onUpdate?: (snapshot: ReplyScanSnapshot) => void;
  onCheckpoint?: (checkpoint: ReplyScanCheckpoint) => void;
  restore?: ReplyScanCheckpoint;
};

export function createReplyScan(ports: ReplyScanPorts) {
  const now = ports.now ?? Date.now;
  const scope = ports.scope ?? {
    channelIds: "all" as const,
    fingerprint: scopeFingerprint("all"),
  };
  let plan: string[] = [];
  let asOf = "";
  let since = "";
  let searchCapped = false;
  let searchIncomplete = false;
  let omittedCount = 0;
  let displayLimitReached = false;
  const failedQueries = new Set<string>();
  let pausedUntil = ports.loadPause?.() ?? 0;
  let started = false;
  let running = false;
  const candidates = new Map<string, ReplyCandidate>();
  const queue: ReplyScanTask[] = [];
  const searches: { query: string; page: number }[] = [];
  const retrySearches: { query: string; page: number }[] = [];
  const calls = { search: 0, history: 0, replies: 0, auth: 0, permalink: 0 };
  let days: 1 | 7 = 1;
  let scanId: string = randomUUID();
  let stable: ReplyScanCheckpoint | undefined;
  const snapshot = (): ReplyScanSnapshot => ({
    candidates: sortReplyCandidates([...candidates.values()]),
    asOf,
    since,
    pendingCount: queue.length + searches.length + retrySearches.length,
    pausedUntil,
    searchCapped,
    searchIncomplete,
    omittedCount,
    displayLimitReached,
    failedQueries: [...failedQueries],
    calls: { ...calls },
  });
  const publish = () => {
    const view = snapshot();
    stable = structuredClone({
      version: 2 as const,
      scope,
      plan,
      scanId,
      days,
      snapshot: view,
      started,
      queue,
      // 同じ取得操作では再試行しない失敗タスクも、再開データには含める。
      searches: [...searches, ...retrySearches],
    });
    ports.onCheckpoint?.(structuredClone(stable));
    ports.onUpdate?.(view);
  };
  if (ports.restore) {
    const restored = structuredClone(ports.restore);
    plan = restored.plan;
    asOf = restored.snapshot.asOf;
    since = restored.snapshot.since;
    pausedUntil = Math.max(pausedUntil, restored.snapshot.pausedUntil);
    searchCapped = restored.snapshot.searchCapped;
    searchIncomplete = restored.snapshot.searchIncomplete;
    omittedCount = restored.snapshot.omittedCount ?? 0;
    displayLimitReached = restored.snapshot.displayLimitReached ?? false;
    for (const query of restored.snapshot.failedQueries ?? [])
      failedQueries.add(query);
    days = restored.days;
    scanId = restored.scanId;
    started = restored.started;
    for (const candidate of restored.snapshot.candidates)
      candidates.set(candidate.key, candidate);
    queue.push(...restored.queue);
    searches.push(...restored.searches);
    Object.assign(calls, restored.snapshot.calls);
    stable = restored;
  }
  function unknown(
    key: string,
    reason: Extract<ReplyEvidence, { kind: "unknown" }>["reason"],
  ) {
    const c = candidates.get(key);
    if (c)
      candidates.set(key, {
        ...c,
        evidence: { kind: "unknown", reason },
        contextIncomplete: true,
      });
  }
  function pause(error: unknown): boolean {
    if (error instanceof SlackApiError && error.kind === "rate_limited") {
      pausedUntil = now() + (error.retryAfter ?? 60) * 1000;
      ports.savePause?.(pausedUntil);
      return true;
    }
    return false;
  }
  async function request(
    method: ApiMethod,
    params: ApiParams,
    deadline: number,
  ) {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new SlackApiError("timeout", "取得予算の時間切れです");
    return ports.api(method, params, {
      signal: ports.signal,
      timeoutMs: Math.min(15000, remaining),
    });
  }
  async function round() {
    pausedUntil = Math.max(pausedUntil, ports.loadPause?.() ?? 0);
    if (running || ports.signal?.aborted || now() < pausedUntil)
      return snapshot();
    running = true;
    const deadline = now() + 60000;
    let used = 0;
    let searchUsed = 0;
    try {
      // 検索は候補発見だけに使い、次ページを同じスキャンで続ける。
      while (
        searches.length &&
        searchUsed < 4 &&
        now() < deadline &&
        !ports.signal?.aborted &&
        now() >= pausedUntil
      ) {
        const task = searches.shift()!;
        try {
          searchUsed++;
          calls.search++;
          const result = await request(
            "search.messages",
            {
              query: task.query,
              sort: "timestamp",
              sort_dir: "desc",
              count: 100,
              page: task.page,
            },
            deadline,
          );
          if (ports.signal?.aborted) {
            searches.unshift(task);
            break;
          }
          failedQueries.delete(task.query);
          searchIncomplete = failedQueries.size > 0;
          const response = object(result.messages);
          const matches = Array.isArray(response.matches)
            ? response.matches
            : [];
          const newCandidates = matches
            .map((m) =>
              candidateFromMatch(
                m,
                ports.identity.userId,
                `${ports.identity.teamId}:${ports.identity.userId}`,
                since,
                asOf,
                ports.knownBotIds,
                scope.senderId,
              ),
            )
            .filter((c): c is ReplyCandidate => Boolean(c));
          for (const c of sortReplyCandidates(newCandidates)) {
            if (
              scope.channelIds !== "all" &&
              !scope.channelIds.includes(c.hit.channelId)
            )
              continue;
            if (!candidates.has(c.key) && candidates.size >= 400) {
              searchCapped = true;
              displayLimitReached = true;
              omittedCount++;
              continue;
            }
            const existing = candidates.get(c.key);
            candidates.set(
              c.key,
              mergeCandidates(existing ? [existing, c] : [c])[0],
            );
          }
          const pages = Number(
            object(response.paging).pages ??
              object(response.pagination).page_count ??
              1,
          );
          if (candidates.size >= 400) {
            searchCapped = true;
            displayLimitReached = true;
            searches.length = 0;
            retrySearches.length = 0;
          }
          if (candidates.size < 400 && task.page < Math.min(pages, 2))
            searches.push({ ...task, page: task.page + 1 });
          if (pages > 2 || (task.page === 2 && matches.length === 100))
            searchCapped = true;
        } catch (error) {
          if (ports.signal?.aborted) {
            searches.unshift(task);
            break;
          }
          searchIncomplete = true;
          failedQueries.add(task.query);
          if (pause(error)) {
            searches.unshift(task);
            break;
          }
          retrySearches.push(task);
        }
        publish();
      }

      searches.push(...retrySearches);
      retrySearches.length = 0;
      if (candidates.size) {
        for (const c of sortReplyCandidates([...candidates.values()]))
          if (
            c.evidence.kind === "unknown" &&
            c.evidence.reason === "root" &&
            !queue.some((t) => t.key === c.key)
          )
            queue.push({
              key: c.key,
              kind: c.hit.threadTs ? "replies" : "root",
              seen: [],
              messages: [],
            });
        started = true;
        publish();
      }
      while (
        queue.length &&
        used < 20 &&
        now() < deadline &&
        !ports.signal?.aborted &&
        now() >= pausedUntil
      ) {
        const task = queue.shift()!;
        const candidate = candidates.get(task.key);
        if (!candidate) continue;
        const method =
          task.kind === "replies"
            ? "conversations.replies"
            : "conversations.history";
        const params: ApiParams = {
          channel: candidate.hit.channelId,
          limit: 15,
          inclusive: true,
        };
        if (task.kind === "root") {
          params.oldest = candidate.anchorTs;
          params.latest = candidate.anchorTs;
        } else if (task.kind === "replies") {
          params.ts = candidate.hit.threadTs ?? candidate.anchorTs;
          params.latest = asOf;
        } else {
          params.oldest = since;
          params.latest = asOf;
        }
        if (task.cursor) params.cursor = task.cursor;
        try {
          used++;
          calls[task.kind === "replies" ? "replies" : "history"]++;
          const result = await request(method, params, deadline);
          if (ports.signal?.aborted) {
            queue.unshift(task);
            break;
          }
          const rawPage = Array.isArray(result.messages) ? result.messages : [];
          const page = rawPage
            .map(rawMessage)
            .map((m) =>
              m && m.userId && ports.knownBotIds?.has(m.userId)
                ? { ...m, bot: true }
                : m,
            )
            .filter((m): m is RawMessage => Boolean(m));
          if (task.kind === "root") {
            const original = page.find((m) => m.ts === candidate.anchorTs);
            if (!original) {
              unknown(task.key, "root");
              continue;
            }
            const root =
              original.threadTs ??
              (candidate.hit.channelKind !== "im" ? original.ts : undefined);
            const key = `${ports.identity.teamId}:${ports.identity.userId}:${candidate.hit.channelId}:${root ?? "dm"}`;
            const fixed = {
              ...candidate,
              key,
              hit: { ...candidate.hit, threadTs: root },
              messages: uniqueMessages([...candidate.messages, original]),
            };
            candidates.delete(task.key);
            const existing = candidates.get(key);
            const merged = mergeCandidates(
              existing ? [existing, fixed] : [fixed],
            )[0];
            candidates.set(key, merged);
            // 同じ親を確認するタスクは既存のタスクへ統合する。
            if (!queue.some((q) => q.key === key && q.kind !== "root"))
              queue.push({
                key,
                kind: root ? "replies" : "history",
                seen: [],
                messages: [],
              });
          } else {
            const messages = uniqueMessages([...task.messages, ...page]);
            const cursor = String(
              object(result.response_metadata).next_cursor ?? "",
            ).trim();
            const incomplete = Boolean(result.has_more || cursor);
            const readable =
              !task.unreadable &&
              Array.isArray(result.messages) &&
              page.length === rawPage.length;
            candidates.set(
              task.key,
              checkReply(
                candidate,
                messages,
                ports.identity.userId,
                asOf,
                !incomplete && readable,
                now(),
                since,
                scope.senderId,
              ),
            );
            if (
              incomplete &&
              cursor &&
              cursor !== task.cursor &&
              !task.seen.includes(cursor)
            )
              queue.push({
                ...task,
                messages,
                unreadable: !readable,
                cursor,
                seen: [...task.seen, cursor],
              });
            else if (incomplete) unknown(task.key, "cursor");
          }
        } catch (error) {
          if (ports.signal?.aborted) {
            queue.unshift(task);
            break;
          }
          if (pause(error)) {
            unknown(task.key, "rate");
            queue.unshift(task);
            break;
          }
          const reason =
            error instanceof SlackApiError && error.kind === "timeout"
              ? "timeout"
              : error instanceof SlackApiError &&
                  error.code === "invalid_cursor"
                ? "cursor"
                : "permission";
          unknown(task.key, reason);
        }
        publish();
      }
      for (const task of queue) {
        const c = candidates.get(task.key);
        if (c?.evidence.kind === "unknown" && c.evidence.reason !== "rate")
          unknown(task.key, "budget");
      }
      return snapshot();
    } finally {
      searches.push(...retrySearches);
      retrySearches.length = 0;
      running = false;
      publish();
    }
  }
  async function start(period: 1 | 7 = 1) {
    if (asOf) throw new Error("スキャンは一度だけ開始できます");
    days = period;
    const at = now();
    asOf = slackTs(at);
    since = slackTs(at - days * 86400000);
    const date = new Date(at - (days + 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    const before = new Date(at + 2 * 86400000).toISOString().slice(0, 10);
    plan = createReplySearchPlan(scope, ports.identity.userId, date, before);
    searches.push(...plan.map((query) => ({ query, page: 1 })));
    publish();
    return round();
  }
  return {
    start,
    continue: round,
    snapshot,
    checkpoint: () => (stable ? structuredClone(stable) : undefined),
  };
}
export type ReplyScan = ReturnType<typeof createReplyScan>;
