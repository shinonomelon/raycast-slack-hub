import { useEffect, useRef, useState } from "react";
import type { Hit } from "../../slack/hits.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import {
  emptyHistory,
  HistoryController,
  type HistoryMode,
  type HistoryState,
} from "./history-controller.ts";

export function useHistory(session: Session, hit: Hit, mode: HistoryMode) {
  const account = session.canFetch ? scopeKey(session.fetchAs) : undefined;
  const key = `${mode}:${hit.channelId}:${hit.ts}:${hit.threadTs ?? ""}`;
  const [snapshot, setSnapshot] = useState<{
    api: Session["api"];
    account?: string;
    key: string;
    state: HistoryState;
  }>();
  const [nonce, setNonce] = useState(0);
  const publish = useRef<(state: HistoryState) => void>(() => {});
  const ref = useRef<HistoryController | undefined>(undefined);
  ref.current ??= new HistoryController((state) => publish.current(state));
  const source = useRef(hit);
  source.current = hit;
  useEffect(() => {
    publish.current = (state) =>
      setSnapshot({ api: session.api, account, key, state });
    const controller = ref.current!;
    void controller.load(session, source.current, mode);
    return () => controller.cancel();
  }, [session.api, session.canFetch, account, key, mode, nonce]);
  const state: HistoryState = !session.canFetch
    ? {
        ...emptyHistory(),
        status: "auth-required",
        error: "認証を確認し、Hubを開き直してください",
      }
    : snapshot?.api === session.api &&
        snapshot.account === account &&
        snapshot.key === key
      ? snapshot.state
      : { ...emptyHistory(), status: "loading" };
  return {
    ...state,
    refresh: () => setNonce((value) => value + 1),
    more: () => ref.current!.more(),
    retry: () => ref.current!.retry(),
    earlier: () => ref.current!.extend("earlier"),
    later: () => ref.current!.extend("later"),
  };
}
