import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Identity } from "./identity.ts";
const MAX_BYTES = 16 * 1024 * 1024;
const DAY = 86400000;
export type DirectoryCheckpoint = {
  fingerprint: string;
  startedAt: number;
  cursor?: string;
  rows: unknown[];
  seen: string[];
  retryAt?: number;
  complete?: boolean;
};
export type RefreshSchedule = { lastStartedAt: number; identity?: Identity };
export class DirectoryRefreshStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    // 完成キャッシュと予定は残し、期限切れの取得途中データだけ回収する。
    for (const name of readdirSync(root)) {
      if (!/^checkpoint-[a-f0-9]{64}$/.test(name)) continue;
      try {
        const path = join(root, name);
        if (Date.now() - statSync(path).mtimeMs >= DAY) unlinkSync(path);
      } catch {
        /* 別実行が削除した場合は何もしない。 */
      }
    }
  }
  path(key: string): string {
    return join(
      this.root,
      `${key.startsWith("checkpoint-") ? "checkpoint-" : ""}${createHash("sha256").update(key).digest("hex")}`,
    );
  }
  read<T>(key: string): T | undefined {
    try {
      const path = this.path(key);
      if (statSync(path).size > MAX_BYTES) return undefined;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }
  write(key: string, value: unknown): void {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_BYTES)
      throw new Error("Directory checkpoint exceeds storage limit");
    const path = this.path(key);
    const temp = `${path}.${randomUUID()}`;
    try {
      writeFileSync(temp, raw, { mode: 0o600 });
      renameSync(temp, path);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* 一時ファイルが残った場合だけ削除する。 */
      }
    }
  }
  remove(key: string): void {
    try {
      unlinkSync(this.path(key));
    } catch {
      /* 未保存なら何もしない。 */
    }
  }
  checkpoint(
    key: string,
    fingerprint: string,
    now: number,
  ): DirectoryCheckpoint | undefined {
    const value = this.read<DirectoryCheckpoint>(key);
    if (
      !value ||
      value.fingerprint !== fingerprint ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt > now ||
      now - value.startedAt >= DAY ||
      !Array.isArray(value.rows) ||
      !Array.isArray(value.seen) ||
      !value.seen.every((x) => typeof x === "string") ||
      (value.cursor !== undefined && typeof value.cursor !== "string") ||
      (value.retryAt !== undefined && !Number.isFinite(value.retryAt)) ||
      (value.complete !== undefined && typeof value.complete !== "boolean")
    )
      return undefined;
    return value;
  }
}
