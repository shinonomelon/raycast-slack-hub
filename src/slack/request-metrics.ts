import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireFileLease } from "./file-lease.ts";
import type { ApiSource } from "./slack-api.ts";
const sources = new Set([
  "background",
  "directory",
  "search",
  "triage",
  "reply-priority",
  "membership",
  "thread-context",
  "reply-check",
  "post",
  "auth",
  "unknown",
]);
const methods = new Set([
  "cache",
  "auth.test",
  "conversations.list",
  "conversations.members",
  "users.list",
  "users.conversations",
  "search.messages",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "conversations.open",
  "chat.postMessage",
]);
export type Metric =
  "requests" | "rateLimited" | "cacheHits" | "waitMs" | "coalesced";
export type RequestMetrics = {
  record(
    source: ApiSource,
    method: string,
    metric: Metric,
    value?: number,
  ): void;
};
// 診断には固定の操作元、API名、数値だけを保存する。
export function createRequestMetrics(
  path: string,
  now = Date.now,
): RequestMetrics {
  mkdirSync(dirname(path), { recursive: true });
  return {
    record(source, method, metric, value = 1) {
      if (
        !sources.has(source) ||
        !methods.has(method) ||
        !Number.isFinite(value)
      )
        return;
      const lease = acquireFileLease(`${path}.lock`, 5000, now);
      if (!lease) return;
      try {
        let rows: {
          source: ApiSource;
          method: string;
          at: number;
          requests: number;
          rateLimited: number;
          cacheHits: number;
          waitMs: number;
          coalesced: number;
        }[] = [];
        try {
          rows = JSON.parse(readFileSync(path, "utf8"))
            .filter(
              (row: { at: number }) =>
                row.at <= now() && now() - row.at < 7 * 86400000,
            )
            .filter(
              (row: { source: string; method: string }) =>
                sources.has(row.source) && methods.has(row.method),
            )
            .map((row: Record<string, unknown>) => ({
              source: row.source as ApiSource,
              method: row.method as string,
              at: row.at as number,
              requests: Number.isFinite(row.requests)
                ? Math.max(0, Number(row.requests))
                : 0,
              rateLimited: Number.isFinite(row.rateLimited)
                ? Math.max(0, Number(row.rateLimited))
                : 0,
              cacheHits: Number.isFinite(row.cacheHits)
                ? Math.max(0, Number(row.cacheHits))
                : 0,
              waitMs: Number.isFinite(row.waitMs)
                ? Math.max(0, Number(row.waitMs))
                : 0,
              coalesced: Number.isFinite(row.coalesced)
                ? Math.max(0, Number(row.coalesced))
                : 0,
            }))
            .slice(-255);
        } catch {
          /* 診断の破損は通信を止めない。 */
        }
        let row = rows.find(
          (r) =>
            r.source === source &&
            r.method === method &&
            Math.floor(r.at / 86400000) === Math.floor(now() / 86400000),
        );
        if (!row) {
          row = {
            source,
            method,
            at: now(),
            requests: 0,
            rateLimited: 0,
            cacheHits: 0,
            waitMs: 0,
            coalesced: 0,
          };
          rows.push(row);
        }
        row[metric] = Math.min(
          Number.MAX_SAFE_INTEGER,
          row[metric] + Math.max(0, value),
        );

        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
        lease.runIfOwner(() => renameSync(tmp, path));
      } catch {
        /* 診断の保存失敗は通信を止めない。 */
      } finally {
        lease.release();
      }
    },
  };
}
