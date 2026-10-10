import { useEffect, useRef, useState } from "react";
import type { Session } from "../../slack/identity.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import {
  DiscoveryController,
  ListsController,
  sessionStamp,
  type DiscoveryState,
  type ItemsState,
} from "./lists-controller.ts";
export function useLists(session: Session) {
  const [state, setState] = useState<DiscoveryState>({
    lists: [],
    total: 0,
    page: 0,
    hasMore: true,
    capped: false,
    busy: false,
  });
  const controller = useRef<DiscoveryController | undefined>(undefined);
  const stamp = sessionStamp(session);
  const owner = useRef<{ api: Session["api"]; stamp: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    const current = new DiscoveryController(
      session.api,
      session.display.teamId,
      setState,
    );
    controller.current = current;
    owner.current = { api: session.api, stamp };
    setState(current.state);
    if (session.canFetch && FEATURE_GATES.listsRead) void current.load();
    return () => current.dispose();
  }, [session.api, stamp]);
  const current =
    owner.current?.api === session.api &&
    owner.current.stamp === stamp &&
    session.canFetch;
  return {
    state: current
      ? state
      : {
          lists: [],
          total: 0,
          page: 0,
          hasMore: false,
          capped: false,
          busy: false,
        },
    loadMore: () =>
      owner.current?.api === session.api &&
      owner.current.stamp === stamp &&
      session.canFetch &&
      controller.current?.load(),
    refresh: () =>
      owner.current?.api === session.api &&
      owner.current.stamp === stamp &&
      session.canFetch &&
      controller.current?.load(true),
    refreshAfterWrite: async () => {
      if (
        owner.current?.api !== session.api ||
        owner.current.stamp !== stamp ||
        !session.canFetch
      )
        return;
      const active = controller.current;
      await active?.load(true);
      if (active?.state.error) throw new Error(active.state.error);
    },
  };
}
export function useListItems(
  session: Session,
  listId: string,
  archived: boolean,
) {
  const [state, setState] = useState<ItemsState>({
    items: [],
    cursor: "",
    loaded: false,
    busy: false,
    capped: false,
  });
  const controller = useRef<ListsController | undefined>(undefined);
  const stamp = `${sessionStamp(session)}:${listId}:${archived}`;
  const owner = useRef<{ api: Session["api"]; stamp: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    const current = new ListsController(
      session.api,
      session.display.teamId,
      listId,
      archived,
      setState,
    );
    controller.current = current;
    owner.current = { api: session.api, stamp };
    setState(current.state);
    if (session.canFetch && FEATURE_GATES.listsRead) void current.load();
    return () => current.dispose();
  }, [session.api, stamp]);
  const current =
    owner.current?.api === session.api &&
    owner.current.stamp === stamp &&
    session.canFetch;
  return {
    state: current
      ? state
      : { items: [], cursor: "", loaded: false, busy: false, capped: false },
    loadMore: () =>
      owner.current?.api === session.api &&
      owner.current.stamp === stamp &&
      session.canFetch &&
      controller.current?.load(),
    refresh: () =>
      owner.current?.api === session.api &&
      owner.current.stamp === stamp &&
      session.canFetch &&
      controller.current?.load(true),
    refreshAfterWrite: async () => {
      if (
        owner.current?.api !== session.api ||
        owner.current.stamp !== stamp ||
        !session.canFetch
      )
        return;
      const active = controller.current;
      await active?.load(true);
      if (active?.state.error) throw new Error(active.state.error);
    },
  };
}
