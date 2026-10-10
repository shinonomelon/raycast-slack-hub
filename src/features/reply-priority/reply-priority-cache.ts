import { createHash, randomUUID } from "node:crypto";
import {
  AI_PROMPT_VERSION,
  JEV_MODEL,
  validAIResult,
  type AIResult,
} from "./reply-priority-ai.ts";
import {
  createReplyScan,
  type ReplyScanCheckpoint,
  type ReplyScanPorts,
} from "./reply-priority-fetch.ts";
import type { ReplyCachePort } from "./reply-priority-store.ts";

export const REPLY_RESULT_TTL = 5 * 60 * 1000;
export const REPLY_DECISION_NAMESPACE = "reply-priority-decisions";
export type ReplyBinding = {
  teamId: string;
  userId: string;
  fingerprint: string;
};
export type PersistentReplyAI = {
  key: string;
  hash: string;
  result: AIResult;
  scoredAt: number;
  applied: boolean;
};
export function reusableReplyAI(
  entry: PersistentReplyAI,
  inputHash: string,
  now: number,
): boolean {
  return (
    entry.hash === inputHash &&
    fresh(entry.scoredAt, now) &&
    validAIResult(entry.result)
  );
}
type JsonObject = Record<string, unknown>;
const obj = (v: unknown): v is JsonObject =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown): v is string => typeof v === "string";
const ts = (v: unknown): v is string => text(v) && /^\d+\.\d{6}$/.test(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const id = (v: unknown): v is string => text(v) && /^[A-Za-z0-9]+$/.test(v);
const hash = (v: unknown): v is string => text(v) && /^[a-f0-9]{64}$/.test(v);
const scope = (b: Pick<ReplyBinding, "teamId" | "userId">) =>
  `${b.teamId}:${b.userId}`;
const fresh = (at: number, now: number) =>
  at <= now && now - at < REPLY_RESULT_TTL;
const validCalls = (v: unknown) =>
  obj(v) &&
  ["search", "history", "replies", "auth", "permalink"].every(
    (k) => Number.isSafeInteger(v[k]) && Number(v[k]) >= 0,
  );
const message = (m: unknown) =>
  obj(m) &&
  ts(m.ts) &&
  text(m.text) &&
  (m.userId === undefined || id(m.userId)) &&
  (m.threadTs === undefined || ts(m.threadTs)) &&
  (m.bot === undefined || typeof m.bot === "boolean") &&
  (m.subtype === undefined || text(m.subtype)) &&
  (m.reactions === undefined ||
    (Array.isArray(m.reactions) &&
      m.reactions.every(
        (r) =>
          obj(r) && text(r.name) && Array.isArray(r.users) && r.users.every(id),
      )));

export function replyBinding(
  identity: { teamId: string; userId: string },
  token: string,
  aiKey: string,
): ReplyBinding {
  return {
    ...identity,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([token, aiKey, JEV_MODEL, AI_PROMPT_VERSION]))
      .digest("hex"),
  };
}
export function validReplyCheckpoint(
  value: unknown,
  binding: ReplyBinding,
  period: 1 | 7,
  now: number,
): value is ReplyScanCheckpoint {
  if (
    !obj(value) ||
    value.version !== 1 ||
    value.days !== period ||
    !text(value.scanId) ||
    !/^[a-f0-9-]{36}$/.test(value.scanId) ||
    typeof value.started !== "boolean" ||
    !obj(value.snapshot) ||
    !Array.isArray(value.queue) ||
    !Array.isArray(value.searches)
  )
    return false;
  const s = value.snapshot;
  if (
    !ts(s.asOf) ||
    !ts(s.since) ||
    !fresh(Number(s.asOf) * 1000, now) ||
    Math.abs(Number(s.asOf) - Number(s.since) - period * 86400) > 0.000002 ||
    !Array.isArray(s.candidates) ||
    s.candidates.length > 400 ||
    !finite(s.pendingCount) ||
    s.pendingCount !== value.queue.length + value.searches.length ||
    !finite(s.pausedUntil) ||
    s.pausedUntil < 0 ||
    typeof s.searchCapped !== "boolean" ||
    typeof s.searchIncomplete !== "boolean" ||
    !validCalls(s.calls)
  )
    return false;
  const prefix = `${scope(binding)}:`;
  const keys = new Set<string>();
  for (const c of s.candidates) {
    if (
      !obj(c) ||
      !text(c.key) ||
      !c.key.startsWith(prefix) ||
      keys.has(c.key) ||
      !obj(c.hit) ||
      !id(c.hit.channelId) ||
      !ts(c.hit.ts) ||
      !text(c.hit.text) ||
      !text(c.hit.key) ||
      !text(c.hit.permalink) ||
      !["channel", "private", "im", "mpim"].includes(
        String(c.hit.channelKind),
      ) ||
      typeof c.hit.mentionsSelf !== "boolean" ||
      (c.hit.threadTs !== undefined && !ts(c.hit.threadTs)) ||
      (c.hit.userId !== undefined && !id(c.hit.userId)) ||
      (c.hit.username !== undefined && !text(c.hit.username)) ||
      (c.hit.channelName !== undefined && !text(c.hit.channelName)) ||
      !c.key.startsWith(`${prefix}${c.hit.channelId}:`) ||
      !ts(c.anchorTs) ||
      !ts(c.firstPendingTs) ||
      !Array.isArray(c.messages) ||
      !c.messages.every(message) ||
      typeof c.contextIncomplete !== "boolean" ||
      typeof c.waitingLowerBound !== "boolean" ||
      !obj(c.evidence)
    )
      return false;
    const e = c.evidence;
    if (
      !(e.kind === "self-post-after" && ts(e.ts)) &&
      !(
        e.kind === "no-self-post" &&
        finite(e.checkedAt) &&
        e.checkedAt <= now &&
        e.asOf === s.asOf
      ) &&
      !(
        e.kind === "unknown" &&
        [
          "budget",
          "permission",
          "rate",
          "timeout",
          "root",
          "partial",
          "cursor",
        ].includes(String(e.reason))
      )
    )
      return false;
    keys.add(c.key);
  }
  if (
    value.queue.length > 400 ||
    !value.queue.every(
      (t) =>
        obj(t) &&
        text(t.key) &&
        keys.has(t.key) &&
        ["root", "history", "replies"].includes(String(t.kind)) &&
        (t.cursor === undefined || text(t.cursor)) &&
        Array.isArray(t.seen) &&
        t.seen.every(text) &&
        Array.isArray(t.messages) &&
        t.messages.every(message) &&
        (t.unreadable === undefined || typeof t.unreadable === "boolean"),
    )
  )
    return false;
  if (
    value.searches.length > 4 ||
    !value.searches.every(
      (q) =>
        obj(q) &&
        text(q.query) &&
        (q.query.startsWith(`<@${binding.userId}> after:`) ||
          q.query.startsWith("to:me after:")) &&
        (q.page === 1 || q.page === 2),
    )
  )
    return false;
  return value.started || value.queue.length === 0;
}

export function createReplyDecisionCache(
  port: ReplyCachePort,
  binding: ReplyBinding,
  clock: () => number = Date.now,
) {
  let failed = false;
  let epoch: string | undefined;
  const key = (
    b: Pick<ReplyBinding, "teamId" | "userId">,
    kind: string,
    days: 1 | 7,
  ) => `${scope(b)}:${kind}:${days}`;
  const read = (k: string): unknown => {
    let raw: string | undefined;
    try {
      raw = port.get(k);
    } catch {
      failed = true;
      return undefined;
    }
    try {
      return JSON.parse(raw ?? "null");
    } catch {
      return undefined;
    }
  };
  const write = (k: string, value: unknown) => {
    try {
      port.set(k, JSON.stringify(value));
      return true;
    } catch {
      // 消去不能な旧slotも次回復元できないよう、共通bindingの世代を変える。
      failed = true;
      epoch = randomUUID();
      try {
        port.set("active-binding", JSON.stringify({ ...binding, epoch }));
      } catch {
        /* 全書き込み不能なら、このインスタンスでは復元を止める。 */
      }
      return false;
    }
  };
  const clearScope = (b: Pick<ReplyBinding, "teamId" | "userId">) => {
    for (const period of [1, 7] as const) {
      write(key(b, "scan", period), null);
      write(key(b, "ai", period), null);
    }
  };
  function activate() {
    if (failed) return false;
    if (
      !id(binding.teamId) ||
      !id(binding.userId) ||
      !hash(binding.fingerprint)
    )
      return false;
    const previous = read("active-binding");
    if (failed) return false;
    if (
      !obj(previous) ||
      previous.teamId !== binding.teamId ||
      previous.userId !== binding.userId ||
      previous.fingerprint !== binding.fingerprint ||
      !text(previous.epoch) ||
      !/^[a-f0-9-]{36}$/.test(previous.epoch)
    ) {
      epoch = randomUUID();
      if (obj(previous) && id(previous.teamId) && id(previous.userId))
        clearScope({ teamId: previous.teamId, userId: previous.userId });
      clearScope(binding);
      write("active-binding", { ...binding, epoch });
    } else {
      epoch = previous.epoch;
      // 共通bindingを書けない場合は、既存recordもこの回では使わない。
      write("active-binding", { ...binding, epoch });
    }
    if (failed) return false;
    // 読み込み時に両期間の期限切れ原文を消す。非起動中の自動消去は行わない。
    for (const period of [1, 7] as const) {
      const slot = key(binding, "scan", period);
      const previousScan = read(slot);
      if (
        previousScan &&
        (!recordMatches(previousScan) ||
          !validReplyCheckpoint(
            previousScan.checkpoint,
            binding,
            period,
            clock(),
          ))
      )
        write(slot, null);
    }
    return !failed;
  }
  const recordMatches = (v: unknown): v is JsonObject =>
    obj(v) &&
    v.version === 1 &&
    v.teamId === binding.teamId &&
    v.userId === binding.userId &&
    v.fingerprint === binding.fingerprint &&
    v.epoch === epoch &&
    v.model === JEV_MODEL &&
    v.promptVersion === AI_PROMPT_VERSION;
  function loadScan(period: 1 | 7): ReplyScanCheckpoint | undefined {
    if (!activate()) return undefined;
    const k = key(binding, "scan", period),
      value = read(k);
    if (failed) return undefined;
    if (
      !recordMatches(value) ||
      !validReplyCheckpoint(value.checkpoint, binding, period, clock())
    ) {
      write(k, null);
      return undefined;
    }
    return structuredClone(value.checkpoint);
  }
  function saveScan(period: 1 | 7, checkpoint: ReplyScanCheckpoint) {
    if (
      activate() &&
      validReplyCheckpoint(checkpoint, binding, period, clock())
    )
      write(key(binding, "scan", period), {
        version: 1,
        ...binding,
        epoch,
        model: JEV_MODEL,
        promptVersion: AI_PROMPT_VERSION,
        checkpoint,
      });
  }
  function loadAI(period: 1 | 7): PersistentReplyAI[] {
    if (!activate()) return [];
    const k = key(binding, "ai", period),
      value = read(k);
    if (failed) return [];
    if (!recordMatches(value) || !Array.isArray(value.entries)) {
      write(k, null);
      return [];
    }
    const entries = value.entries.filter(
      (entry): entry is PersistentReplyAI =>
        obj(entry) &&
        text(entry.key) &&
        entry.key.startsWith(`${scope(binding)}:`) &&
        hash(entry.hash) &&
        finite(entry.scoredAt) &&
        fresh(entry.scoredAt, clock()) &&
        typeof entry.applied === "boolean" &&
        obj(entry.result) &&
        validAIResult(entry.result as AIResult),
    );
    if (entries.length !== value.entries.length)
      write(k, { ...value, entries });
    return failed ? [] : structuredClone(entries);
  }
  function saveAI(period: 1 | 7, entries: readonly PersistentReplyAI[]) {
    if (!activate()) return;
    write(key(binding, "ai", period), {
      version: 1,
      ...binding,
      epoch,
      model: JEV_MODEL,
      promptVersion: AI_PROMPT_VERSION,
      entries,
    });
    loadAI(period);
  }
  function clearPeriod(period: 1 | 7) {
    if (activate()) {
      write(key(binding, "scan", period), null);
      write(key(binding, "ai", period), null);
    }
  }
  function invalidate() {
    clearScope(binding);
    const active = read("active-binding");
    if (
      obj(active) &&
      active.teamId === binding.teamId &&
      active.userId === binding.userId
    )
      write("active-binding", { ...binding, epoch: randomUUID() });
    failed = true;
  }
  return {
    loadScan,
    saveScan,
    loadAI,
    saveAI,
    clearPeriod,
    invalidate,
    activate,
  };
}
export type ReplyDecisionCache = ReturnType<typeof createReplyDecisionCache>;
export function openCachedReplyScan(
  cache: ReplyDecisionCache,
  period: 1 | 7,
  ports: ReplyScanPorts,
  refresh = false,
  canPersist: () => boolean = () => true,
) {
  if (refresh) cache.clearPeriod(period);
  const restore = refresh ? undefined : cache.loadScan(period);
  const scan = createReplyScan({
    ...ports,
    restore,
    onCheckpoint: (checkpoint) => {
      if (!ports.signal?.aborted && canPersist())
        cache.saveScan(period, checkpoint);
      ports.onCheckpoint?.(checkpoint);
    },
  });
  return {
    scan,
    fromCache: Boolean(restore),
    begin: () =>
      restore ? Promise.resolve(scan.snapshot()) : scan.start(period),
  };
}
