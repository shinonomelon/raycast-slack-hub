import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFileLease } from "./file-lease.ts";
export type MethodState = {
  updatedAt: number;
  nextStartAt: number;
  pausedUntil: number;
};
export interface RequestPolicyStore {
  update(
    key: string,
    method: string,
    operation: (state: MethodState) => MethodState,
  ): MethodState | undefined;
}
export function createMemoryPolicyStore(): RequestPolicyStore {
  const states = new Map<string, MethodState>();
  return {
    update(key, method, operation) {
      const id = `${key}:${method}`;
      const state = operation(
        states.get(id) ?? { updatedAt: 0, nextStartAt: 0, pausedUntil: 0 },
      );
      states.set(id, state);
      return state;
    },
  };
}
export function createRequestPolicyStore(
  root: string,
  now = Date.now,
): RequestPolicyStore {
  mkdirSync(root, { recursive: true });
  return {
    update(key, method, operation) {
      if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-z]+\.[a-zA-Z]+$/.test(method))
        throw new Error("Invalid policy key");
      const path = join(root, `${key}-${method}.json`);
      const lease = acquireFileLease(`${path}.lock`, 5000, now);
      if (!lease) return undefined;
      try {
        let state: MethodState = {
          updatedAt: 0,
          nextStartAt: 0,
          pausedUntil: 0,
        };
        try {
          const data = JSON.parse(readFileSync(path, "utf8"));
          if (
            [data.updatedAt, data.nextStartAt, data.pausedUntil].every(
              Number.isFinite,
            ) &&
            now() >= data.updatedAt &&
            now() - data.updatedAt < 86400000 * 7
          )
            state = {
              updatedAt: data.updatedAt,
              nextStartAt: data.nextStartAt,
              pausedUntil: data.pausedUntil,
            };
        } catch {
          /* 破損状態は再作成する。 */
        }
        const next = operation(state);
        if (!lease.isOwner()) return undefined;
        const tmp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        if (!lease.isOwner()) return undefined;
        return lease.runIfOwner(() => {
          renameSync(tmp, path);
          return next;
        });
      } finally {
        lease.release();
      }
    },
  };
}
