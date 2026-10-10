import { randomUUID } from "node:crypto";
import type { Conversation } from "../../shared/types.ts";

export type LibraryIdentity = { teamId: string; userId: string };
export type ChannelLibrary = LibraryIdentity & {
  version: 1;
  favoriteChannelIds: string[];
  sections: { id: string; name: string; channelIds: string[] }[];
};
export type LibraryDocument = {
  version: 1;
  accounts: Record<string, ChannelLibrary>;
  legacyClaims: Record<string, string>;
};
export type LibraryMutation =
  | { kind: "favorite"; channelId: string; favorite: boolean }
  | { kind: "create-section"; name: string }
  | { kind: "rename-section"; sectionId: string; name: string }
  | { kind: "delete-section"; sectionId: string }
  | { kind: "set-section-channels"; sectionId: string; channelIds: string[] }
  | { kind: "set-channel-sections"; channelId: string; sectionIds: string[] };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const channelId = (id: unknown): id is string =>
  typeof id === "string" && /^[CG][A-Z0-9]+$/.test(id);
export function libraryKey(identity: LibraryIdentity): string {
  if (
    !/^T[A-Z0-9]+$/.test(identity.teamId) ||
    !/^[UW][A-Z0-9]+$/.test(identity.userId)
  )
    throw new Error("アカウント識別情報が不正です");
  return `${identity.teamId}-${identity.userId}`;
}
export function emptyLibrary(identity: LibraryIdentity): ChannelLibrary {
  libraryKey(identity);
  return { version: 1, ...identity, favoriteChannelIds: [], sections: [] };
}
function channels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(channelId))
    throw new Error("チャンネルIDの保存データが不正です");
  return [...new Set(value)];
}
function sectionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
    throw new Error("セクション名は1〜100文字で入力してください");
  return value.trim();
}
export function parseLibraryDocument(raw: unknown): LibraryDocument {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !record(raw.accounts) ||
    !record(raw.legacyClaims)
  )
    throw new Error(
      "整理ファイルが壊れています。復旧してから再読み込みしてください",
    );
  const accounts: Record<string, ChannelLibrary> = {};
  for (const [key, value] of Object.entries(raw.accounts)) {
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.teamId !== "string" ||
      typeof value.userId !== "string" ||
      !Array.isArray(value.sections)
    )
      throw new Error("アカウントの保存データが不正です");
    const identity = { teamId: value.teamId, userId: value.userId };
    if (libraryKey(identity) !== key)
      throw new Error("保存先アカウントが一致しません");
    const ids = new Set<string>();
    const names = new Set<string>();
    const sections = value.sections.map((section) => {
      if (
        !record(section) ||
        typeof section.id !== "string" ||
        !/^[A-Za-z0-9-]{1,100}$/.test(section.id) ||
        ids.has(section.id)
      )
        throw new Error("セクションIDの保存データが不正です");
      const name = sectionName(section.name);
      if (names.has(name))
        throw new Error("同名のセクションが保存されています");
      ids.add(section.id);
      names.add(name);
      return { id: section.id, name, channelIds: channels(section.channelIds) };
    });
    accounts[key] = {
      version: 1,
      ...identity,
      favoriteChannelIds: channels(value.favoriteChannelIds),
      sections,
    };
  }
  const legacyClaims: Record<string, string> = {};
  for (const [id, owner] of Object.entries(raw.legacyClaims)) {
    if (
      !channelId(id) ||
      typeof owner !== "string" ||
      !Object.hasOwn(accounts, owner)
    )
      throw new Error("旧お気に入りの取り込み記録が不正です");
    legacyClaims[id] = owner;
  }
  return { version: 1, accounts, legacyClaims };
}
export function initializeLibrary(
  document: LibraryDocument,
  identity: LibraryIdentity,
  conversations: readonly Conversation[],
  directoryComplete: boolean,
  legacyFavorites: readonly string[],
): boolean {
  const key = libraryKey(identity);
  if (Object.hasOwn(document.accounts, key) || !directoryComplete) return false;
  const known = new Set(
    conversations
      .filter((c) => c.type === "public" || c.type === "private")
      .map((c) => c.id),
  );
  const library = emptyLibrary(identity);
  library.favoriteChannelIds = [...new Set(legacyFavorites)].filter(
    (id) =>
      channelId(id) &&
      known.has(id) &&
      !Object.hasOwn(document.legacyClaims, id),
  );
  document.accounts[key] = library;
  for (const id of library.favoriteChannelIds) document.legacyClaims[id] = key;
  return true;
}
export function applyLibraryMutation(
  library: ChannelLibrary,
  mutation: LibraryMutation,
  generateId: () => string = randomUUID,
): ChannelLibrary {
  const next = structuredClone(library);
  const find = (id: string) => {
    const section = next.sections.find((s) => s.id === id);
    if (!section)
      throw new Error("セクションが削除されています。再読み込みしてください");
    return section;
  };
  const named = (name: string, except?: string) => {
    const normalized = sectionName(name);
    if (next.sections.some((s) => s.id !== except && s.name === normalized))
      throw new Error("同じ名前のセクションがあります");
    return normalized;
  };
  switch (mutation.kind) {
    case "favorite": {
      channels([mutation.channelId]);
      next.favoriteChannelIds = mutation.favorite
        ? [...new Set([...next.favoriteChannelIds, mutation.channelId])]
        : next.favoriteChannelIds.filter((id) => id !== mutation.channelId);
      break;
    }
    case "create-section":
      next.sections.push({
        id: generateId(),
        name: named(mutation.name),
        channelIds: [],
      });
      break;
    case "rename-section":
      find(mutation.sectionId).name = named(mutation.name, mutation.sectionId);
      break;
    case "delete-section":
      find(mutation.sectionId);
      next.sections = next.sections.filter((s) => s.id !== mutation.sectionId);
      break;
    case "set-section-channels":
      find(mutation.sectionId).channelIds = channels(mutation.channelIds);
      break;
    case "set-channel-sections": {
      channels([mutation.channelId]);
      for (const id of mutation.sectionIds) find(id);
      const members = new Set(mutation.sectionIds);
      for (const section of next.sections)
        section.channelIds = members.has(section.id)
          ? [...new Set([...section.channelIds, mutation.channelId])]
          : section.channelIds.filter((id) => id !== mutation.channelId);
      break;
    }
  }
  return next;
}
