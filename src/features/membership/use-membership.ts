import { useEffect, useRef, useState } from "react";
import { scopeKey, type Session } from "../../slack/identity.ts";
import type { Conversation } from "../../shared/types.ts";
import { MembershipController } from "./membership-controller.ts";
import {
  targetKey,
  type MembershipState,
  type MembershipTarget,
} from "./membership.ts";

export function useMembership(session: Session, target: MembershipTarget) {
  const key = targetKey(target);
  const account = session.canFetch ? scopeKey(session.fetchAs) : undefined;
  const [nonce, setNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    api: Session["api"];
    account?: string;
    key: string;
    state: MembershipState;
  }>();
  const publish = useRef<(state: MembershipState) => void>(() => {});
  const controller = useRef<MembershipController | undefined>(undefined);
  controller.current ??= new MembershipController((state) =>
    publish.current(state),
  );
  const lastNonce = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    publish.current = (state) =>
      setSnapshot({ api: session.api, account, key, state });
    const instance = controller.current!;
    const refresh = lastNonce.current !== nonce;
    lastNonce.current = nonce;
    void instance.load(session, targetRef.current, refresh);
    return () => instance.cancel();
  }, [session.api, session.canFetch, account, key, nonce]);
  // effectが動く前の描画でも、別の認証・対象の結果を出さない。
  const state: MembershipState = !session.canFetch
    ? { status: "auth-required", data: [] }
    : snapshot?.api === session.api &&
        snapshot.account === account &&
        snapshot.key === key
      ? snapshot.state
      : { status: "loading", data: [] };
  return { ...state, refresh: () => setNonce((value) => value + 1) };
}
export function usePersonChannels(
  session: Session,
  userIds: readonly string[],
) {
  const state = useMembership(session, { kind: "channels", userIds });
  return { ...state, data: state.data as readonly Conversation[] };
}
export function useChannelMembers(session: Session, channelId: string) {
  const state = useMembership(session, { kind: "members", channelId });
  return { ...state, data: state.data as readonly string[] };
}
