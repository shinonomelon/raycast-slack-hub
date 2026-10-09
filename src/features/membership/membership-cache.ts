import type { ApiCall } from "../../slack/slack-api.ts";
import type { MembershipData } from "./membership.ts";

export const MEMBERSHIP_TTL_MS = 120_000;
export const MAX_CACHE_ENTRIES = 20;
export const MAX_CACHE_IDS = 10_000;
export type MembershipEntry = { data: MembershipData; fetchedAt: number };
// 認証クライアントが捨てられると、その参加関係も保持し続けない。
export class MembershipCache {
  private clients = new WeakMap<ApiCall, Map<string, MembershipEntry>>();
  get(
    api: ApiCall,
    scope: string,
    key: string,
    now: number,
  ): MembershipEntry | undefined {
    const entries = this.clients.get(api);
    const name = `${scope}:${key}`;
    const entry = entries?.get(name);
    if (!entry) return undefined;
    if (now - entry.fetchedAt >= MEMBERSHIP_TTL_MS || now < entry.fetchedAt) {
      entries?.delete(name);
      return undefined;
    }
    entries?.delete(name);
    entries?.set(name, entry);
    return this.copy(entry);
  }
  set(api: ApiCall, scope: string, key: string, entry: MembershipEntry): void {
    const name = `${scope}:${key}`;
    const entries = this.clients.get(api) ?? new Map<string, MembershipEntry>();
    this.clients.set(api, entries);
    entries.delete(name);
    if (entry.data.length > MAX_CACHE_IDS) return;
    entries.set(name, this.copy(entry));
    const count = () =>
      [...entries.values()].reduce((sum, value) => sum + value.data.length, 0);
    while (entries.size > MAX_CACHE_ENTRIES || count() > MAX_CACHE_IDS)
      entries.delete(entries.keys().next().value!);
  }
  private copy(entry: MembershipEntry): MembershipEntry {
    return {
      fetchedAt: entry.fetchedAt,
      data: entry.data.map((value) =>
        typeof value === "string" ? value : { ...value },
      ) as MembershipData,
    };
  }
}
export const membershipCache = new MembershipCache();
