import { useEffect, useRef, useState } from "react";
import type { Hit } from "../../slack/hits.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import { fetchReactions } from "./reactions-api.ts";
import type { MessageReaction } from "./reactions-model.ts";

type ReactionRead = {
  status: "loading" | "ready" | "failed";
  reactions: MessageReaction[];
  error?: string;
};
export function useReactions(session: Session, hit: Hit) {
  const account = session.canFetch ? scopeKey(session.fetchAs) : undefined;
  const key = `${hit.channelId}:${hit.ts}`;
  const [nonce, setNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    api: Session["api"];
    account?: string;
    key: string;
    nonce: number;
    state: ReactionRead;
  }>();
  const generation = useRef(0);
  const source = useRef(hit);
  source.current = hit;
  useEffect(() => {
    const value = ++generation.current;
    const abort = new AbortController();
    const update = (state: ReactionRead) => {
      if (generation.current === value && !abort.signal.aborted)
        setSnapshot({ api: session.api, account, key, nonce, state });
    };
    if (!session.canFetch) return () => abort.abort();
    update({ status: "loading", reactions: [] });
    void fetchReactions(
      session.api,
      source.current,
      session.fetchAs.userId,
      abort.signal,
    )
      .then((reactions) => update({ status: "ready", reactions }))
      .catch((error: unknown) =>
        update({
          status: "failed",
          reactions: [],
          error:
            error instanceof SlackApiError && error.code === "missing_scope"
              ? "reactions:readを追加し、再認証してください"
              : error instanceof SlackApiError && error.kind === "rate_limited"
                ? "Slack APIの回数制限です。待ってからRefreshしてください"
                : "リアクションを取得できませんでした。権限と認証を確認してください",
        }),
      );
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [session.api, session.canFetch, account, key, nonce]);
  const state: ReactionRead = !session.canFetch
    ? {
        status: "failed",
        reactions: [],
        error: "認証を確認し、Hubを開き直してください",
      }
    : snapshot?.api === session.api &&
        snapshot.account === account &&
        snapshot.key === key &&
        snapshot.nonce === nonce
      ? snapshot.state
      : { status: "loading", reactions: [] };
  return { ...state, refresh: () => setNonce((value) => value + 1) };
}
