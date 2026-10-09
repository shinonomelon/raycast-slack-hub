// ID から表示名を引く純粋な部品。@raycast/api を読み込まないので、node のテストから動かせる
import type { Hit } from "./hits.ts";
import type { NameLookup } from "./mrkdwn.ts";
import { mpimDisplayName } from "../features/search/search.ts";
import type { Conversation, Person } from "../shared/types.ts";

// ID から表示名を引く。DM の channel.name は相手のユーザーID で返る（2026年10月4日に確認）。
// selfHandles は自分のハンドルの一覧（auth.test の user と Previous Handles）。グループDMの名前から自分を除くのに使う
export function buildNames(
  conversations: readonly Conversation[],
  people: readonly Person[],
  selfHandles: readonly string[],
) {
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const handleToName = new Map(people.map((p) => [p.handle, p.displayName]));
  const byConversation = new Map(conversations.map((c) => [c.id, c]));
  const mpimName = (name: string) =>
    mpimDisplayName(name, handleToName, selfHandles);
  const channelName = (id: string) => {
    const c = byConversation.get(id);
    if (!c) return undefined;
    return c.type === "mpim" ? mpimName(c.name) : c.name;
  };
  const lookup: NameLookup = {
    user: (id) => byPerson.get(id)?.displayName,
    channel: channelName,
  };
  const conversationLabel = (hit: Hit) => {
    if (hit.channelKind === "im") {
      return byPerson.get(hit.channelName ?? "")?.displayName ?? "DM";
    }
    if (hit.channelKind === "mpim") {
      return hit.channelName
        ? mpimName(hit.channelName)
        : (channelName(hit.channelId) ?? "グループDM");
    }
    return `#${hit.channelName ?? channelName(hit.channelId) ?? hit.channelId}`;
  };
  // bot の投稿はユーザーID が無く、名前だけのことがある
  const sender = (hit: Hit) =>
    (hit.userId && byPerson.get(hit.userId)?.displayName) ||
    hit.username ||
    "不明";
  const handleOf = (userId?: string) =>
    userId ? byPerson.get(userId)?.handle : undefined;
  return { lookup, conversationLabel, sender, handleOf };
}

export type Names = ReturnType<typeof buildNames>;
