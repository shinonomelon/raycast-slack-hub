import {
  compareTs,
  normalizeMatch,
  parsePermalink,
  type Hit,
} from "../../slack/hits.ts";

export type RawMessage = {
  ts: string;
  text: string;
  userId?: string;
  threadTs?: string;
  bot?: boolean;
  subtype?: string;
  reactions?: { name: string; users: string[] }[];
};
export type ReplyEvidence =
  | { kind: "self-post-after"; ts: string }
  | { kind: "no-self-post"; checkedAt: number; asOf: string }
  | {
      kind: "unknown";
      reason:
        | "budget"
        | "permission"
        | "rate"
        | "timeout"
        | "root"
        | "partial"
        | "cursor";
    };
export type ReplyCandidate = {
  key: string;
  hit: Hit;
  anchorTs: string;
  firstPendingTs: string;
  messages: RawMessage[];
  evidence: ReplyEvidence;
  contextIncomplete: boolean;
  waitingLowerBound: boolean;
};
export type LocalDisposition =
  | { kind: "dismissed"; anchorTs: string; at: number }
  | { kind: "snoozed"; anchorTs: string; at: number; until: number };
export type Dispositions = Record<string, LocalDisposition>;
export const MARK_TTL = 14 * 24 * 60 * 60 * 1000;
export const slackTs = (ms: number) =>
  `${Math.floor(ms / 1000)}.${Math.floor(ms % 1000)
    .toString()
    .padStart(3, "0")}000`;
export function rawMessage(raw: unknown): RawMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.ts !== "string" || !/^\d+\.\d+$/.test(m.ts)) return undefined;
  return {
    ts: m.ts,
    text: typeof m.text === "string" ? m.text : "",
    userId: typeof m.user === "string" ? m.user : undefined,
    threadTs: typeof m.thread_ts === "string" ? m.thread_ts : undefined,
    bot: Boolean(m.bot_id || m.bot_profile || m.user === "USLACKBOT"),
    subtype: typeof m.subtype === "string" ? m.subtype : undefined,
    reactions: Array.isArray(m.reactions)
      ? m.reactions
          .filter((r) => r && typeof r === "object")
          .map((r) => {
            const v = r as Record<string, unknown>;
            return {
              name: String(v.name ?? ""),
              users: Array.isArray(v.users)
                ? v.users.filter((u): u is string => typeof u === "string")
                : [],
            };
          })
      : undefined,
  };
}
export function targetMessage(
  message: RawMessage,
  isIm: boolean,
  selfId: string,
  since: string,
  asOf: string,
): boolean {
  return Boolean(
    message.userId &&
    message.userId !== selfId &&
    message.userId !== "USLACKBOT" &&
    !message.bot &&
    (!message.subtype || message.subtype === "thread_broadcast") &&
    compareTs(message.ts, since) >= 0 &&
    compareTs(message.ts, asOf) <= 0 &&
    (isIm ||
      message.text.includes(`<@${selfId}>`) ||
      message.text.includes(`<@${selfId}|`)),
  );
}
export function candidateFromMatch(
  raw: unknown,
  selfId: string,
  scope: string,
  since: string,
  asOf: string,
  knownBotIds: ReadonlySet<string> = new Set(),
): ReplyCandidate | undefined {
  const hit = normalizeMatch(raw, selfId);
  const message = rawMessage(raw);
  if (
    !hit ||
    !message ||
    (message.userId !== undefined && knownBotIds.has(message.userId)) ||
    !targetMessage(message, hit.channelKind === "im", selfId, since, asOf)
  )
    return undefined;
  const fromLink = parsePermalink(hit.permalink)?.threadTs;
  const root =
    message.threadTs && fromLink && message.threadTs !== fromLink
      ? undefined
      : (message.threadTs ?? fromLink);
  hit.threadTs = root;
  return {
    key: `${scope}:${hit.channelId}:${root ?? `unresolved-${hit.ts}`}`,
    hit,
    anchorTs: hit.ts,
    firstPendingTs: hit.ts,
    messages: [message],
    evidence: { kind: "unknown", reason: "root" },
    contextIncomplete: true,
    waitingLowerBound: false,
  };
}
export function mergeCandidates(
  candidates: readonly ReplyCandidate[],
): ReplyCandidate[] {
  const result = new Map<string, ReplyCandidate>();
  for (const item of candidates) {
    const old = result.get(item.key);
    if (!old) {
      result.set(item.key, { ...item, messages: [...item.messages] });
      continue;
    }
    const newest = compareTs(old.anchorTs, item.anchorTs) < 0 ? item : old;
    result.set(item.key, {
      ...newest,
      firstPendingTs:
        compareTs(old.firstPendingTs, item.firstPendingTs) < 0
          ? old.firstPendingTs
          : item.firstPendingTs,
      messages: uniqueMessages([...old.messages, ...item.messages]),
    });
  }
  return sortReplyCandidates([...result.values()]);
}
export function uniqueMessages(messages: readonly RawMessage[]): RawMessage[] {
  return [...new Map(messages.map((m) => [m.ts, m])).values()].sort((a, b) =>
    compareTs(a.ts, b.ts),
  );
}
export function checkReply(
  candidate: ReplyCandidate,
  messages: readonly RawMessage[],
  selfId: string,
  asOf: string,
  complete: boolean,
  checkedAt: number,
  since: string,
): ReplyCandidate {
  const normalDm =
    candidate.hit.channelKind === "im" && !candidate.hit.threadTs;
  const relevant = uniqueMessages(messages).filter(
    (m) =>
      compareTs(m.ts, asOf) <= 0 &&
      (normalDm
        ? !m.threadTs || m.threadTs === m.ts
        : m.ts === candidate.hit.threadTs ||
          m.threadTs === candidate.hit.threadTs),
  );
  const latestTarget = relevant
    .filter((m) => targetMessage(m, normalDm, selfId, since, asOf))
    .at(-1);
  const anchorTs =
    latestTarget && compareTs(latestTarget.ts, candidate.anchorTs) > 0
      ? latestTarget.ts
      : candidate.anchorTs;
  const hasAnchor = relevant.some((m) => m.ts === anchorTs);
  const hasParent =
    normalDm || relevant.some((m) => m.ts === candidate.hit.threadTs);
  const selfAfter = relevant.find(
    (m) => m.userId === selfId && !m.bot && compareTs(m.ts, anchorTs) > 0,
  );
  let firstPendingTs = candidate.firstPendingTs;
  if (normalDm) {
    const lastSelf = relevant.filter((m) => m.userId === selfId).at(-1)?.ts;
    const incoming = relevant.filter(
      (m) =>
        targetMessage(m, true, selfId, since, asOf) &&
        (!lastSelf || compareTs(m.ts, lastSelf) > 0),
    );
    firstPendingTs = incoming[0]?.ts ?? firstPendingTs;
  }
  return {
    ...candidate,
    anchorTs,
    hit:
      latestTarget && latestTarget.ts === anchorTs
        ? {
            ...candidate.hit,
            ts: anchorTs,
            text: latestTarget.text.slice(0, 300),
            userId: latestTarget.userId,
          }
        : candidate.hit,
    firstPendingTs,
    messages: relevant,
    contextIncomplete:
      !complete || !hasAnchor || !hasParent || relevant.some((m) => !m.text),
    waitingLowerBound:
      normalDm && complete && !relevant.some((m) => m.userId === selfId),
    evidence:
      complete && hasAnchor && selfAfter
        ? { kind: "self-post-after", ts: selfAfter.ts }
        : complete && hasAnchor
          ? { kind: "no-self-post", checkedAt, asOf }
          : { kind: "unknown", reason: "partial" },
  };
}
export function sortReplyCandidates(
  candidates: readonly ReplyCandidate[],
): ReplyCandidate[] {
  return [...candidates].sort(
    (a, b) => compareTs(b.anchorTs, a.anchorTs) || a.key.localeCompare(b.key),
  );
}
export function dispositionOf(
  candidate: ReplyCandidate,
  marks: Dispositions,
  now: number,
): LocalDisposition | undefined {
  const mark = marks[candidate.key];
  return mark &&
    mark.at <= now &&
    now - mark.at < MARK_TTL &&
    compareTs(candidate.anchorTs, mark.anchorTs) <= 0 &&
    (mark.kind !== "snoozed" || now < mark.until)
    ? mark
    : undefined;
}
export function snoozeUntil(kind: "hour" | "tomorrow", now: number): number {
  if (kind === "hour") return now + 3600000;
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}
