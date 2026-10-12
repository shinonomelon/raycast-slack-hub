import { t } from "../../shared/i18n.ts";
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
      title={t("Hide Details")}
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
      (context.session.fetchAs?.userId === id ? t("自分") : id),
  );
  const conditions = t(
    "全員が参加（{0}/{1}人）: {2}",
    ids.length,
    MAX_PEOPLE,
    labels.join("・"),
  );
  const controls = [
    context.session.canFetch && ids.length < MAX_PEOPLE ? (
      <Action.Push
        key="add-person"
        title={t("Add Person")}
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
        title={t("Remove Person")}
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
        title={t("Reset People")}
        icon={Icon.ArrowCounterClockwise}
        onAction={() => setIds([personId])}
      />
    ) : null,
    context.session.canFetch ? (
      <Action
        key="refresh"
        title={t("Refresh")}
        icon={Icon.ArrowClockwise}
        onAction={state.refresh}
      />
    ) : null,
    <Action
      key="preferences"
      title={t("Open Extension Preferences")}
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />,
  ].filter(Boolean);
  const [primaryControl, ...otherControls] = controls;
  return (
    <List
      navigationTitle={t("参加チャンネル")}
      searchBarPlaceholder={t("チャンネル名・別名で絞り込む")}
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
          state.status === "deferred" ||
          state.status === "auth-required"
            ? t("参加チャンネルを取得できません")
            : state.status === "loading"
              ? t("参加チャンネルを取得中")
              : text
                ? t("名前に一致するチャンネルがありません")
                : t("この条件のチャンネルはありません")
        }
        description={t(
          "{0}\n公開チャンネルと、自分も参加する非公開チャンネル（アーカイブ除外）\n{1}",
          conditions,
          membershipStatus(state),
        )}
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
        subtitle={t(
          "公開・自分も参加する非公開（アーカイブ除外） \u00B7 {0}",
          membershipStatus(state),
        )}
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
                  title={t("Open in Slack")}
                  target={slackAppChannelLink(
                    context.session.display.teamId,
                    row.id,
                  )}
                  application="Slack"
                />
                <Action
                  title={detail ? t("Hide Details") : t("Show Details")}
                  icon={Icon.Sidebar}
                  shortcut={DETAILS_SHORTCUT}
                  onAction={() => setDetail((value) => !value)}
                />
                <Action.Push
                  title={t("Write")}
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
                  title={t("Search in This Conversation")}
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
                  title={t("View Members")}
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
