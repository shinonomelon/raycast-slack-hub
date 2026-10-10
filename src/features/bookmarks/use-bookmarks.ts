import { useEffect, useRef, useState } from "react";
import { scopeKey, type Session } from "../../slack/identity.ts";
import {
  BookmarksController,
  type BookmarksState,
} from "./bookmarks-controller.ts";

export function useBookmarks(session: Session, channelId: string) {
  const account = session.canFetch ? scopeKey(session.fetchAs) : undefined;
  const publish = useRef<(state: BookmarksState) => void>(() => {});
  const controller = useRef<BookmarksController | undefined>(undefined);
  controller.current ??= new BookmarksController((state) =>
    publish.current(state),
  );
  const latest = useRef({
    api: session.api,
    account,
    channelId,
    canFetch: session.canFetch,
  });
  latest.current = {
    api: session.api,
    account,
    channelId,
    canFetch: session.canFetch,
  };
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{
    api: Session["api"];
    account?: string;
    channelId: string;
    state: BookmarksState;
  }>();
  useEffect(() => {
    mounted.current = true;
    publish.current = (state) =>
      setSnapshot({ api: session.api, account, channelId, state });
    void controller.current!.load(session, channelId);
    return () => {
      mounted.current = false;
      controller.current!.cancel();
    };
  }, [session.api, session.canFetch, account, channelId]);
  const state: BookmarksState = !session.canFetch
    ? {
        status: "auth-required",
        data: [],
        message: "認証を確認し、Slack Hubを開き直してください",
      }
    : snapshot?.api === session.api &&
        snapshot.account === account &&
        snapshot.channelId === channelId
      ? snapshot.state
      : { status: "loading", data: [] };
  const current = () =>
    mounted.current &&
    latest.current.api === session.api &&
    latest.current.account === account &&
    latest.current.channelId === channelId &&
    latest.current.canFetch === session.canFetch;
  return {
    ...state,
    refresh: () =>
      current()
        ? controller.current!.load(session, channelId)
        : Promise.resolve(false),
    invalidate: () => {
      if (current()) controller.current!.invalidate();
    },
  };
}
