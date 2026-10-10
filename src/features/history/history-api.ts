import type { Hit } from "../../slack/hits.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import {
  HISTORY_PAGE_SIZE,
  parseHistoryPage,
  validTimestamp,
  type HistoryRange,
} from "./history-model.ts";

export async function fetchHistoryPage(
  api: ApiCall,
  hit: Hit,
  range: HistoryRange,
  signal: AbortSignal,
  cursor?: string,
) {
  if (!/^[CDG][A-Z0-9]+$/.test(hit.channelId) || !validTimestamp(hit.ts))
    throw new SlackApiError("configuration", "会話と時刻を確認してください");
  return parseHistoryPage(
    hit.channelId,
    await api(
      "conversations.history",
      {
        channel: hit.channelId,
        ...range,
        inclusive: true,
        limit: HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    ),
  );
}
export async function fetchThreadPage(
  api: ApiCall,
  hit: Hit,
  parentTs: string,
  latest: string,
  signal: AbortSignal,
  cursor?: string,
) {
  if (!/^[CDG][A-Z0-9]+$/.test(hit.channelId) || !validTimestamp(parentTs))
    throw new SlackApiError(
      "configuration",
      "会話とスレッドの時刻を確認してください",
    );
  return parseHistoryPage(
    hit.channelId,
    await api(
      "conversations.replies",
      {
        channel: hit.channelId,
        ts: parentTs,
        latest,
        inclusive: true,
        limit: HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    ),
  );
}
