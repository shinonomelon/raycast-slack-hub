import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { ListsBrowser } from "./lists-screen.tsx";
export function ListPicker({
  context,
  hit,
}: {
  context: MembershipContext;
  hit: Hit;
}) {
  if (!FEATURE_GATES.listsRead || !FEATURE_GATES.listsWrite)
    return <ApiGateNotice title="Create Task from Message" />;
  return <ListsBrowser context={context} hit={hit} />;
}
