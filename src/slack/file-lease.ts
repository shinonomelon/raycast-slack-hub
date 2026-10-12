import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export type FileLease = {
  isOwner(): boolean;
  renew(): boolean;
  release(): void;
  runIfOwner<T>(operation: () => T): T | undefined;
};
type Owner = {
  nonce: string;
  pid: number;
  startedAt: number;
  expiresAt: number;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
export function acquireFileLease(
  path: string,
  leaseMs: number,
  now = Date.now,
): FileLease | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const read = (): Owner | undefined => {
    try {
      const owner = JSON.parse(readFileSync(`${path}/owner.json`, "utf8"));
      return typeof owner.nonce === "string" &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        Number.isFinite(owner.startedAt) &&
        Number.isFinite(owner.expiresAt)
        ? owner
        : undefined;
    } catch {
      return undefined;
    }
  };
  // 生存中のプロセスが保持する短い操作ロックは期限だけでは奪わない。
  const guarded = <T>(operation: () => T): T | undefined => {
    const guard = `${path}.guard`;
    const recovery = `${guard}.recovery`;
    try {
      statSync(recovery);
      let dead = false;
      try {
        const pid = Number(readFileSync(`${recovery}/pid`, "utf8"));
        dead = Number.isInteger(pid) && pid > 0 && !alive(pid);
      } catch {
        dead = Math.abs(Date.now() - statSync(recovery).mtimeMs) > 5000;
      }
      if (!dead) return undefined;
      rmSync(recovery, { recursive: true, force: true });
    } catch {
      /* 復旧中でなければ操作できる。 */
    }
    try {
      mkdirSync(guard);
    } catch {
      let abandoned = false;
      try {
        const pid = Number(readFileSync(`${guard}/pid`, "utf8"));
        abandoned = Number.isInteger(pid) && pid > 0 && !alive(pid);
      } catch {
        try {
          abandoned = Math.abs(Date.now() - statSync(guard).mtimeMs) > 5000;
        } catch {
          return undefined;
        }
      }
      if (!abandoned) return undefined;
      try {
        mkdirSync(recovery);
        writeFileSync(`${recovery}/pid`, String(process.pid));
      } catch {
        return undefined;
      }
      try {
        let stillAbandoned = false;
        try {
          const pid = Number(readFileSync(`${guard}/pid`, "utf8"));
          stillAbandoned = Number.isInteger(pid) && pid > 0 && !alive(pid);
        } catch {
          try {
            stillAbandoned =
              Math.abs(Date.now() - statSync(guard).mtimeMs) > 5000;
          } catch {
            return undefined;
          }
        }
        if (!stillAbandoned) return undefined;
        rmSync(guard, { recursive: true });
        mkdirSync(guard);
      } catch {
        return undefined;
      } finally {
        rmSync(recovery, { recursive: true, force: true });
      }
    }
    writeFileSync(`${guard}/pid`, String(process.pid));
    try {
      return operation();
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  };
  const owner: Owner = {
    nonce: randomUUID(),
    pid: process.pid,
    startedAt: now(),
    expiresAt: now() + leaseMs,
  };
  const owned = () => {
    const current = read();
    return (
      current?.nonce === owner.nonce &&
      now() >= current.startedAt &&
      now() < current.expiresAt
    );
  };
  const acquired = guarded(() => {
    const current = read();
    if (
      current &&
      alive(current.pid) &&
      now() >= current.startedAt &&
      now() < current.expiresAt
    )
      return false;
    if (!current) {
      try {
        if (Math.abs(Date.now() - statSync(path).mtimeMs) < 5000) return false;
      } catch {
        /* 未作成のロックは取得できる。 */
      }
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
    writeFileSync(`${path}/owner.json`, JSON.stringify(owner), { mode: 0o600 });
    return true;
  });
  if (!acquired) return undefined;
  return {
    isOwner: owned,
    renew() {
      return (
        guarded(() => {
          if (!owned()) return false;
          owner.expiresAt = now() + leaseMs;
          writeFileSync(`${path}/owner.json`, JSON.stringify(owner), {
            mode: 0o600,
          });
          return true;
        }) ?? false
      );
    },
    release() {
      guarded(() => {
        if (read()?.nonce === owner.nonce)
          rmSync(path, { recursive: true, force: true });
      });
    },
    runIfOwner<T>(operation: () => T) {
      return guarded(() => (owned() ? operation() : undefined));
    },
  };
}
