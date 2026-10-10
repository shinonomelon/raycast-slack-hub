import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation } from "../../shared/types.ts";
import {
  applyLibraryMutation,
  emptyLibrary,
  initializeLibrary,
  libraryKey,
  parseLibraryDocument,
  type ChannelLibrary,
  type LibraryDocument,
  type LibraryIdentity,
  type LibraryMutation,
} from "./model.ts";

export class LibraryStoreError extends Error {
  readonly code: "locked" | "recovery" | "corrupt";
  constructor(code: "locked" | "recovery" | "corrupt", message: string) {
    super(message);
    this.name = "LibraryStoreError";
    this.code = code;
  }
}
export const LIBRARY_MAX_BYTES = 1024 * 1024;
export type SaveStage =
  "before-write" | "after-write" | "before-rename" | "after-rename";
export function createChannelLibraryStore(
  supportPath: string,
  options: { maxBytes?: number; checkpoint?: (stage: SaveStage) => void } = {},
) {
  const path = join(supportPath, "channel-library.json");
  const lock = `${path}.lock`;
  const limit = options.maxBytes ?? LIBRARY_MAX_BYTES;
  function read(): LibraryDocument {
    try {
      if (statSync(path).size > limit)
        throw new Error(
          "整理ファイルがサイズ上限を超えています。復旧してから再読み込みしてください",
        );
      return parseLibraryDocument(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, accounts: {}, legacyClaims: {} };
      throw new LibraryStoreError(
        "corrupt",
        "整理ファイルを読めません。正本を復旧してから再読み込みしてください",
      );
    }
  }
  const recovery = `${lock}.recovery`;
  const locked = () =>
    new LibraryStoreError(
      "locked",
      "別の画面またはプロセスが保存中です。再試行してください",
    );
  const unsafe = () =>
    new LibraryStoreError(
      "recovery",
      "保存ロックの所有者を確認できません。整理ファイルを保護したままロックを復旧してください",
    );
  function owner() {
    try {
      const value = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      if (
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.nonce !== "string" ||
        !value.nonce
      )
        throw unsafe();
      return value as { pid: number; nonce: string };
    } catch {
      throw unsafe();
    }
  }
  function dead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw unsafe();
    }
  }
  function acquire() {
    if (existsSync(recovery)) throw unsafe();
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const old = owner();
      if (!dead(old.pid)) throw locked();
      // 回復中に新規所有者が入れないよう、通常取得も確認する回復用排他を持つ。
      try {
        mkdirSync(recovery);
      } catch {
        throw unsafe();
      }
      try {
        const current = owner();
        if (
          current.pid !== old.pid ||
          current.nonce !== old.nonce ||
          !dead(current.pid)
        )
          throw locked();
        const retired = `${lock}.${randomUUID()}.retired`;
        renameSync(lock, retired);
        rmSync(retired, { recursive: true, force: true });
      } finally {
        rmSync(recovery, { recursive: true, force: true });
      }
      try {
        mkdirSync(lock);
      } catch {
        throw locked();
      }
    }
    try {
      if (existsSync(recovery)) throw unsafe();
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
        { flag: "wx" },
      );
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
  }
  async function transaction(
    update: (document: LibraryDocument) => boolean,
  ): Promise<LibraryDocument> {
    mkdirSync(supportPath, { recursive: true });
    acquire();
    let temporary: string | undefined;
    try {
      // 排他取得後に正本を読み直し、別画面が保存した変更を残す。
      const document = read();
      if (!update(document)) return document;
      const serialized = JSON.stringify(document, null, 2);
      if (Buffer.byteLength(serialized) > limit)
        throw new Error(
          "整理データがサイズ上限を超えています。保存内容を減らしてください",
        );
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      options.checkpoint?.("before-write");
      writeFileSync(temporary, serialized, { flag: "wx" });
      options.checkpoint?.("after-write");
      options.checkpoint?.("before-rename");
      renameSync(temporary, path);
      temporary = undefined;
      options.checkpoint?.("after-rename");
      return document;
    } finally {
      try {
        if (temporary) rmSync(temporary, { force: true });
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
  }
  const account = (document: LibraryDocument, identity: LibraryIdentity) =>
    structuredClone(
      document.accounts[libraryKey(identity)] ?? emptyLibrary(identity),
    );
  return {
    load: async (
      identity: LibraryIdentity,
    ): Promise<{ library: ChannelLibrary; ready: boolean }> => {
      const document = read();
      return {
        library: account(document, identity),
        ready: Object.hasOwn(document.accounts, libraryKey(identity)),
      };
    },
    initialize: async (
      identity: LibraryIdentity,
      conversations: readonly Conversation[],
      directoryComplete: boolean,
      legacyFavorites: readonly string[],
    ): Promise<{ library: ChannelLibrary; ready: boolean }> => {
      const document = await transaction((latest) =>
        initializeLibrary(
          latest,
          identity,
          conversations,
          directoryComplete,
          legacyFavorites,
        ),
      );
      return {
        library: account(document, identity),
        ready: Object.hasOwn(document.accounts, libraryKey(identity)),
      };
    },
    mutate: async (
      identity: LibraryIdentity,
      mutation: LibraryMutation,
    ): Promise<ChannelLibrary> => {
      const key = libraryKey(identity);
      const document = await transaction((latest) => {
        if (!Object.hasOwn(latest.accounts, key))
          throw new Error(
            "ディレクトリ取得完了後に整理データを初期化してください",
          );
        latest.accounts[key] = applyLibraryMutation(
          latest.accounts[key],
          mutation,
        );
        return true;
      });
      return account(document, identity);
    },
  };
}
