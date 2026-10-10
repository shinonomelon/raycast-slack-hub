import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { HistoryView } from "./history-screen.tsx";

export function ThreadScreen({
  context,
  hit,
}: {
  context: MembershipContext;
  hit: Hit;
}) {
  if (
    !FEATURE_GATES.history[hit.channelKind] ||
    (!hit.threadTs && !FEATURE_GATES.threadReplyTs)
  )
    return <ApiGateNotice title="Thread" />;
  return <HistoryView context={context} hit={hit} mode="thread" />;
}
