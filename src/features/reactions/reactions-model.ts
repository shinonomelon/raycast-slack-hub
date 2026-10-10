import { object, SlackApiError } from "../../slack/slack-api.ts";
import { validTimestamp } from "../history/history-model.ts";

export const STANDARD_REACTIONS = [
  { name: "white_check_mark", label: "✅ 確認しました" },
  { name: "thumbsup", label: "👍 いいね" },
  { name: "eyes", label: "👀 見ています" },
  { name: "heart", label: "❤️ ありがとう" },
  { name: "tada", label: "🎉 お祝い" },
  { name: "pray", label: "🙏 お願い・感謝" },
] as const;
export const validReactionName = (name: string) =>
  /^[a-zA-Z0-9_+-]+(?:::skin-tone-[2-6])?$/.test(name);
export type MessageReaction = { name: string; count: number; mine: boolean };
export function readMessageReactions(
  data: Record<string, unknown>,
  channelId: string,
  ts: string,
  selfId: string,
): MessageReaction[] {
  const message = object(data.message);
  const unreadable = () =>
    new SlackApiError("unreadable", "リアクションの応答を読み取れませんでした");
  if (
    data.ok !== true ||
    data.type !== "message" ||
    data.channel !== channelId ||
    !validTimestamp(message.ts) ||
    message.ts !== ts
  )
    throw unreadable();
  if (message.reactions === undefined) return [];
  if (!Array.isArray(message.reactions)) throw unreadable();
  const seen = new Set<string>();
  return message.reactions.map((raw) => {
    const reaction = object(raw);
    if (
      typeof reaction.name !== "string" ||
      !validReactionName(reaction.name) ||
      seen.has(reaction.name) ||
      !Array.isArray(reaction.users) ||
      reaction.users.some((id) => typeof id !== "string") ||
      typeof reaction.count !== "number" ||
      !Number.isInteger(reaction.count) ||
      reaction.count < 0
    )
      throw unreadable();
    seen.add(reaction.name);
    // APIは全ユーザーを返さない場合があるが、本人が反応済みなら本人IDを含む。
    return {
      name: reaction.name,
      count: reaction.count,
      mine: reaction.users.includes(selfId),
    };
  });
}
export function myReactionNames(
  reactions: readonly MessageReaction[],
): string[] {
  return reactions
    .filter((reaction) => reaction.mine)
    .map((reaction) => reaction.name);
}
