import type { Hit } from "../../slack/hits.ts";
import { parsePermalink } from "../../slack/hits.ts";
import type { ApiCall } from "../../slack/slack-api.ts";
import { isSlackUrl } from "./lists-model.ts";
export function taskTitleFromMessage(hit: Pick<Hit, "text">): string {
  return hit.text.replace(/\s+/g, " ").trim().slice(0, 120);
}
export function sourceMatchesHit(
  url: unknown,
  hit: Pick<Hit, "channelId" | "ts">,
): url is string {
  if (!isSlackUrl(url)) return false;
  const link = parsePermalink(url);
  return link?.channelId === hit.channelId && link.ts === hit.ts;
}
export async function messageTaskSource(
  api: ApiCall,
  hit: Hit,
): Promise<string> {
  if (sourceMatchesHit(hit.permalink, hit)) return hit.permalink;
  const raw = await api("chat.getPermalink", {
    channel: hit.channelId,
    message_ts: hit.ts,
  });
  if (!sourceMatchesHit(raw.permalink, hit))
    throw new Error(
      "元メッセージのURLを取得できません。通常のAdd Taskを使ってください",
    );
  return raw.permalink;
}
