import {
  classifyAIResult,
  rankAICandidates,
  type AIResult,
} from "./reply-priority-ai.ts";
import {
  dispositionOf,
  type Dispositions,
  type ReplyCandidate,
} from "./reply-priority.ts";

export type ReplySection =
  "review" | "needed" | "possibly-unnecessary" | "pending" | "hidden";
export type ScoredReply = ReplyCandidate & {
  ai?: AIResult;
  section: ReplySection;
};
export type ReplyDisplay = { aiApplied: boolean; filter: string };
export function filterReplyRows<T extends { section: ReplySection }>(
  rows: readonly T[],
  filter: string,
  query: string,
  text: (row: T) => string,
): T[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(
    (row) =>
      (filter === "all" ? row.section !== "hidden" : row.section === filter) &&
      words.every((word) => text(row).toLocaleLowerCase().includes(word)),
  );
}
export function replyDisplayAfter(
  current: ReplyDisplay,
  event: "score" | "apply" | "disable" | "refresh",
): ReplyDisplay {
  if (event === "score") return current;
  const aiApplied = event === "apply";
  const filters = aiApplied
    ? ["all", "review", "needed", "possibly-unnecessary", "hidden"]
    : ["all", "review", "pending", "hidden"];
  return {
    aiApplied,
    filter: filters.includes(current.filter) ? current.filter : "all",
  };
}
export const evidenceComplete = (candidate: ReplyCandidate) =>
  candidate.evidence.kind === "no-self-post" && !candidate.contextIncomplete;
export function replySections(
  candidates: readonly ReplyCandidate[],
  marks: Dispositions,
  results: ReadonlyMap<string, AIResult>,
  aiEnabled: boolean,
  now: number,
): ScoredReply[] {
  const rows = candidates
    .filter((c) => c.evidence.kind !== "self-post-after")
    .map((c) => ({
      ...c,
      ai: results.get(c.key),
      section: dispositionOf(c, marks, now)
        ? ("hidden" as const)
        : aiEnabled
          ? classifyAIResult(results.get(c.key), evidenceComplete(c)).kind
          : evidenceComplete(c)
            ? ("pending" as const)
            : ("review" as const),
    }));
  return aiEnabled
    ? rankAICandidates(
        rows.map((c) => ({
          ...c,
          firstUnansweredTs: c.firstPendingTs,
          evidenceComplete: evidenceComplete(c),
        })),
      )
    : rows;
}
export function replyRoot(candidate: ReplyCandidate): string | undefined {
  if (candidate.key.includes(":unresolved-")) return undefined;
  if (
    candidate.evidence.kind === "unknown" &&
    candidate.evidence.reason === "root"
  )
    return undefined;
  return candidate.hit.threadTs ?? candidate.anchorTs;
}
