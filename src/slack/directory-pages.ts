import { createHash } from "node:crypto";
import {
  object,
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiParams,
} from "./slack-api.ts";
import {
  DirectoryRefreshStore,
  type DirectoryCheckpoint,
} from "./directory-refresh-store.ts";
import { acquireFileLease } from "./file-lease.ts";
export type DirectoryScan =
  | { kind: "complete"; rows: unknown[]; checkpointKey: string }
  | { kind: "pending"; retryAt?: number }
  | { kind: "busy" };
export async function scanDirectory(params: {
  api: ApiCall;
  credentialKey: string;
  kind: string;
  method: ApiMethod;
  field: string;
  params: ApiParams;
  store: DirectoryRefreshStore;
  now?: () => number;
  maxPages?: number;
  budgetMs?: number;
}): Promise<DirectoryScan> {
  const now = params.now ?? Date.now;
  const fullParams = { ...params.params, limit: 200 };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        params.credentialKey,
        params.kind,
        params.method,
        params.field,
        fullParams,
      ]),
    )
    .digest("hex");
  const key = `checkpoint-${fingerprint}`;
  const budget = params.budgetMs ?? 45000;
  const lease = await acquireFileLease(
    `${params.store.path(key)}.lock`,
    budget + 15000,
    now,
  );
  if (!lease) return { kind: "busy" };
  try {
    const started = now();
    const deadlineAt = started + budget;
    const state: DirectoryCheckpoint = params.store.checkpoint(
      key,
      fingerprint,
      started,
    ) ?? { fingerprint, startedAt: started, rows: [], seen: [] };
    if (state.complete)
      return { kind: "complete", rows: state.rows, checkpointKey: key };
    if (state.retryAt && state.retryAt > started)
      return { kind: "pending", retryAt: state.retryAt };
    for (let page = 0; page < (params.maxPages ?? 10); page++) {
      if (now() >= deadlineAt) {
        if (
          !lease.runIfOwner(() => {
            params.store.write(key, state);
            return true;
          })
        )
          return { kind: "busy" };
        return { kind: "pending" };
      }
      if (!(await lease.isOwner())) return { kind: "busy" };
      try {
        const response = await params.api(
          params.method,
          { ...fullParams, ...(state.cursor ? { cursor: state.cursor } : {}) },
          {
            source: "directory",
            deadlineAt,
            timeoutMs: Math.max(1, deadlineAt - now()),
          },
        );
        if (!Array.isArray(response[params.field]))
          throw new SlackApiError(
            "unreadable",
            "Directory response has no rows",
          );
        const rawCursor = object(response.response_metadata).next_cursor;
        const cursor =
          typeof rawCursor === "string" && rawCursor.trim()
            ? rawCursor.trim()
            : undefined;
        if (cursor && state.seen.includes(cursor))
          throw new SlackApiError("unreadable", "Directory cursor repeated");
        if (!(await lease.isOwner())) return { kind: "busy" };
        state.rows.push(...(response[params.field] as unknown[]));
        state.cursor = cursor;
        delete state.retryAt;
        if (cursor) state.seen.push(cursor);
        state.complete = !cursor;
        if (
          !lease.runIfOwner(() => {
            params.store.write(key, state);
            return true;
          })
        )
          return { kind: "busy" };
        if (!cursor)
          return { kind: "complete", rows: state.rows, checkpointKey: key };
        await lease.renew();
      } catch (error) {
        if (
          error instanceof SlackApiError &&
          (error.kind === "rate_limited" ||
            error.kind === "deferred" ||
            error.kind === "timeout" ||
            error.code === "invalid_cursor")
        ) {
          if (error.code === "invalid_cursor") {
            state.rows = [];
            state.seen = [];
            delete state.cursor;
            state.startedAt = now();
          }
          state.retryAt =
            error.retryAt ?? now() + (error.retryAfter ?? 60) * 1000;
          if (await lease.isOwner())
            if (
              !lease.runIfOwner(() => {
                params.store.write(key, state);
                return true;
              })
            )
              return { kind: "busy" };
          return { kind: "pending", retryAt: state.retryAt };
        }
        throw error;
      }
    }
    return { kind: "pending" };
  } finally {
    await lease.release();
  }
}
