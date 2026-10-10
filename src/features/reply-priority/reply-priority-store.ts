import {
  MARK_TTL,
  type Dispositions,
  type LocalDisposition,
} from "./reply-priority.ts";
export type ReplyCachePort = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
};
export function replyPriorityNamespace(identity: {
  teamId: string;
  userId: string;
}): string {
  return `reply-priority-${identity.teamId}-${identity.userId}`;
}
export function createReplyPriorityStore(
  cache: ReplyCachePort,
  scope: string,
  clock: () => number = Date.now,
) {
  const marksKey = `${scope}:marks`;
  const pauseKey = `${scope}:pause`;
  const read = (key: string): unknown => {
    try {
      return JSON.parse(cache.get(key) ?? "null");
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      cache.set(key, JSON.stringify(value));
    } catch {
      /* 保存失敗でも今回の画面は継続する。 */
    }
  };
  function load(now = clock()): Dispositions {
    const raw = read(marksKey);
    const marks: Dispositions = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return marks;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (
        typeof v.anchorTs !== "string" ||
        !/^\d+\.\d+$/.test(v.anchorTs) ||
        typeof v.at !== "number" ||
        !Number.isFinite(v.at) ||
        v.at > now ||
        now - v.at >= MARK_TTL
      )
        continue;
      if (v.kind === "dismissed")
        marks[key] = { kind: "dismissed", anchorTs: v.anchorTs, at: v.at };
      else if (
        v.kind === "snoozed" &&
        typeof v.until === "number" &&
        Number.isFinite(v.until) &&
        v.until > now
      )
        marks[key] = {
          kind: "snoozed",
          anchorTs: v.anchorTs,
          at: v.at,
          until: v.until,
        };
    }
    return marks;
  }
  function set(key: string, disposition: LocalDisposition) {
    write(marksKey, { ...load(), [key]: disposition });
  }
  function remove(key: string) {
    const marks = load();
    delete marks[key];
    write(marksKey, marks);
  }
  function loadPause(): number {
    const value = read(pauseKey);
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value > clock()
      ? value
      : 0;
  }
  function savePause(until: number) {
    write(pauseKey, until);
  }
  return { load, set, remove, loadPause, savePause };
}
export type ReplyPriorityStore = ReturnType<typeof createReplyPriorityStore>;
