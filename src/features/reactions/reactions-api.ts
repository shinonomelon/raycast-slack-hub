import type { Hit } from "../../slack/hits.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import { validTimestamp } from "../history/history-model.ts";
import { runWrite, type WriteOutcome } from "../operations/write-outcome.ts";
import { readMessageReactions, validReactionName } from "./reactions-model.ts";

const validTarget = (hit: Pick<Hit, "channelId" | "ts">) =>
  /^[CDG][A-Z0-9]+$/.test(hit.channelId) && validTimestamp(hit.ts);
export async function fetchReactions(
  api: ApiCall,
  hit: Hit,
  selfId: string,
  signal?: AbortSignal,
) {
  if (!validTarget(hit))
    throw new SlackApiError(
      "configuration",
      "リアクションの対象を確認してください",
    );
  const data = await api(
    "reactions.get",
    { channel: hit.channelId, timestamp: hit.ts, full: true },
    { signal },
  );
  return readMessageReactions(data, hit.channelId, hit.ts, selfId);
}
export async function writeReaction(
  api: ApiCall,
  hit: Hit,
  name: string,
  mode: "add" | "remove",
): Promise<WriteOutcome> {
  if (!validTarget(hit) || !validReactionName(name))
    return { kind: "failed", message: "リアクションと対象を確認してください" };
  // already_reacted/no_reactionは希望した状態が成立している。再送はしない。
  const outcome = await runWrite(
    asyncMethodApi(api, mode),
    mode === "add" ? "reactions.add" : "reactions.remove",
    {
      channel: hit.channelId,
      timestamp: hit.ts,
      name,
    },
  );
  return outcome;
}
function asyncMethodApi(api: ApiCall, mode: "add" | "remove"): ApiCall {
  return async (method, params, options) => {
    try {
      return await api(method, params, options);
    } catch (error) {
      if (
        error instanceof SlackApiError &&
        error.kind === "api" &&
        error.code === (mode === "add" ? "already_reacted" : "no_reaction")
      )
        return { ok: true };
      throw error;
    }
  };
}
