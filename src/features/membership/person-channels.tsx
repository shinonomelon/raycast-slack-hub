import {
  Action,
  ActionPanel,
  Icon,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useState } from "react";
import { toItems } from "../../slack/items.ts";
import { ComposeForm } from "../compose/compose-form.tsx";
import { slackAppChannelLink } from "../compose/compose.ts";
import { addPerson, removePerson, MAX_PEOPLE } from "./membership.ts";
import type { MembershipContext } from "./membership-context.ts";
import { usePersonChannels } from "./use-membership.ts";
import { allMatches, membershipStatus } from "./membership-view.ts";
import { rowDetail } from "../hub/row-detail.ts";
import { DETAILS_SHORTCUT, WRITE_SHORTCUT } from "../hub/shortcuts.ts";
import { PersonPicker } from "./person-picker.tsx";
import { ChannelMembers } from "./channel-members.tsx";
import { ConversationMessages } from "./conversation-messages.tsx";

export function PersonChannels({
  context,
  personId,
}: {
  context: MembershipContext;
  personId: string;
}) {
  const [ids, setIds] = useState([personId]);
  const [text, setText] = useState("");
  const [detail, setDetail] = useState(false);
  const hideDetails = detail ? (
    <Action
      title="Hide Details"
      icon={Icon.Sidebar}
      shortcut={DETAILS_SHORTCUT}
      onAction={() => setDetail(false)}
    />
  ) : null;
  const state = usePersonChannels(context.session, ids);
  const rows = allMatches(toItems(state.data, [], context.prefs, []), text);
  const labels = ids.map(
    (id) =>
      context.people.find((person) => person.id === id)?.displayName ??
      (context.session.fetchAs?.userId === id ? "自分" : id),
  );
  const conditions = `全員が参加（${ids.length}/${MAX_PEOPLE}人）: ${labels.join("・")}`;
  const controls = [
    context.session.canFetch && ids.length < MAX_PEOPLE ? (
      <Action.Push
        key="add-person"
        title="Add Person"
        icon={Icon.AddPerson}
        target={
          <PersonPicker
            context={context}
            ids={ids}
            onSelect={(id) => setIds((current) => addPerson(current, id))}
          />
        }
      />
    ) : null,
    context.session.canFetch && ids.length > 1 ? (
      <Action.Push
        key="remove-person"
        title="Remove Person"
        icon={Icon.Person}
        target={
          <PersonPicker
            context={context}
            ids={ids}
            remove
            onSelect={(id) => setIds((current) => removePerson(current, id))}
          />
        }
      />
    ) : null,
    context.session.canFetch ? (
      <Action
        key="reset-people"
        title="Reset People"
        icon={Icon.ArrowCounterClockwise}
        onAction={() => setIds([personId])}
      />
    ) : null,
    context.session.canFetch ? (
      <Action
        key="refresh"
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={state.refresh}
      />
    ) : null,
    <Action
      key="preferences"
      title="Open Extension Preferences"
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />,
  ].filter(Boolean);
  const [primaryControl, ...otherControls] = controls;
  return (
    <List
      navigationTitle="参加チャンネル"
      searchBarPlaceholder="チャンネル名・別名で絞り込む"
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isShowingDetail={detail}
      isLoading={state.status === "loading"}
    >
      <List.EmptyView
        title={
          state.status === "failed" ||
          state.status === "rate-limited" ||
          state.status === "auth-required"
            ? "参加チャンネルを取得できません"
            : state.status === "loading"
              ? "参加チャンネルを取得中"
              : text
                ? "名前に一致するチャンネルがありません"
                : "この条件のチャンネルはありません"
        }
        description={`${conditions}\n公開チャンネルと、自分も参加する非公開チャンネル（アーカイブ除外）\n${membershipStatus(state)}`}
        actions={
          <ActionPanel>
            {primaryControl}
            {hideDetails}
            {otherControls}
          </ActionPanel>
        }
      />
      <List.Section
        title={conditions}
        subtitle={`公開・自分も参加する非公開（アーカイブ除外） · ${membershipStatus(state)}`}
      >
        {rows.map((row) => (
          <List.Item
            key={row.id}
            title={row.title}
            detail={<List.Item.Detail markdown={rowDetail(row, undefined)} />}
            icon={row.kind === "private" ? Icon.Lock : Icon.Hashtag}
            accessories={row.aliases.map((tag) => ({ tag }))}
            actions={
              <ActionPanel>
                <Action.Open
                  title="Open in Slack"
                  target={slackAppChannelLink(
                    context.session.display.teamId,
                    row.id,
                  )}
                  application="Slack"
                />
                <Action
                  title={detail ? "Hide Details" : "Show Details"}
                  icon={Icon.Sidebar}
                  shortcut={DETAILS_SHORTCUT}
                  onAction={() => setDetail((value) => !value)}
                />
                <Action.Push
                  title="Write"
                  shortcut={WRITE_SHORTCUT}
                  target={
                    <ComposeForm
                      session={context.session}
                      target={{ kind: "conversation", id: row.id }}
                      destination={`#${row.title}`}
                    />
                  }
                />
                <Action.Push
                  title="Search in This Conversation"
                  icon={Icon.MagnifyingGlass}
                  target={
                    <ConversationMessages
                      context={context}
                      channel={{
                        id: row.id,
                        name: row.title,
                        type: row.kind === "private" ? "private" : "public",
                      }}
                    />
                  }
                />
                <Action.Push
                  title="View Members"
                  icon={Icon.TwoPeople}
                  target={
                    <ChannelMembers
                      context={context}
                      channel={{
                        id: row.id,
                        name: row.title,
                        type: row.kind === "private" ? "private" : "public",
                      }}
                    />
                  }
                />
                {controls}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
