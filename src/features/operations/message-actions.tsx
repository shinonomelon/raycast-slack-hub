import { Action, Icon } from "@raycast/api";
import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { HistoryScreen } from "../history/history-screen.tsx";
import { ThreadScreen } from "../history/thread-screen.tsx";
import { ReactionPicker } from "../reactions/reaction-picker.tsx";
import { ListPicker } from "../lists/list-picker.tsx";
import { FEATURE_GATES } from "./feature-gates.ts";

export function MessageActions({
  context,
  hit,
}: {
  context: MembershipContext;
  hit: Hit;
}) {
  return (
    <>
      <Action.Push
        title="View Surrounding Messages"
        icon={Icon.Clock}
        target={<HistoryScreen context={context} hit={hit} />}
      />
      <Action.Push
        title="View Thread"
        icon={Icon.SpeechBubble}
        target={<ThreadScreen context={context} hit={hit} />}
      />
      <Action.Push
        title="Add Reaction"
        icon={Icon.Emoji}
        target={
          <ReactionPicker session={context.session} hit={hit} mode="add" />
        }
      />
      <Action.Push
        title="Remove My Reaction"
        icon={Icon.Emoji}
        target={
          <ReactionPicker session={context.session} hit={hit} mode="remove" />
        }
      />
      {FEATURE_GATES.listsRead && FEATURE_GATES.listsWrite ? (
        <Action.Push
          title="Create Task from Message"
          icon={Icon.CheckList}
          target={<ListPicker context={context} hit={hit} />}
        />
      ) : null}
    </>
  );
}
