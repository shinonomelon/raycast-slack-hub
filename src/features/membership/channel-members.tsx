import { t } from "../../shared/i18n.ts";
import {
  Action,
  ActionPanel,
  Icon,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useState } from "react";
import type { Conversation } from "../../shared/types.ts";
import { ComposeForm } from "../compose/compose-form.tsx";
import { slackAppUserLink } from "../compose/compose.ts";
import type { MembershipContext } from "./membership-context.ts";
import { useChannelMembers } from "./use-membership.ts";
import { allMatches, memberRows, membershipStatus } from "./membership-view.ts";
import { rowDetail } from "../hub/row-detail.ts";
import { DETAILS_SHORTCUT, WRITE_SHORTCUT } from "../hub/shortcuts.ts";
import { PersonChannels } from "./person-channels.tsx";
export function ChannelMembers({
  context,
  channel,
}: {
  context: MembershipContext;
  channel: Conversation;
}) {
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
  const state = useChannelMembers(context.session, channel.id);
  const rows = allMatches(
    memberRows(state.data, context.people, context.prefs),
    text,
  );
  const refresh = context.session.canFetch ? (
    <Action
      title={t("Refresh")}
      icon={Icon.ArrowClockwise}
      onAction={state.refresh}
    />
  ) : null;
  const preferences = (
    <Action
      title={t("Open Extension Preferences")}
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );
  const controls = (
    <>
      {refresh}
      {preferences}
    </>
  );
  const fallbackControls = (
    <>
      {refresh ?? preferences}
      {hideDetails}
      {refresh ? preferences : null}
    </>
  );
  return (
    <List
      navigationTitle={t("#{0} の参加者", channel.name)}
      searchBarPlaceholder={t("名前・ハンドルで絞り込む")}
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isShowingDetail={detail}
      isLoading={state.status === "loading"}
    >
      <List.EmptyView
        title={
          state.status === "loading"
            ? t("参加者を取得中")
            : state.status === "failed" ||
                state.status === "rate-limited" ||
                state.status === "deferred" ||
                state.status === "auth-required"
              ? t("参加者を取得できません")
              : text
                ? t("名前に一致する参加者がいません")
                : t("参加者はいません")
        }
        description={`#${channel.name}\n${membershipStatus(state)}`}
        actions={<ActionPanel>{fallbackControls}</ActionPanel>}
      />
      <List.Section
        title={t("#{0} の参加者", channel.name)}
        subtitle={membershipStatus(state)}
      >
        {rows.map((row) => (
          <List.Item
            key={row.id}
            title={row.title}
            detail={<List.Item.Detail markdown={rowDetail(row, row.person)} />}
            subtitle={row.subtitle}
            icon={
              row.person?.isBot
                ? Icon.ComputerChip
                : row.actionable
                  ? Icon.Person
                  : Icon.QuestionMarkCircle
            }
            actions={
              <ActionPanel>
                {row.actionable ? (
                  <>
                    <Action.Open
                      title={t("Open in Slack")}
                      target={slackAppUserLink(
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
                          target={{ kind: "person", id: row.id }}
                          destination={`@${row.title}`}
                        />
                      }
                    />
                    <Action.Push
                      title={t("View Channels with This Person")}
                      icon={Icon.Hashtag}
                      target={
                        <PersonChannels context={context} personId={row.id} />
                      }
                    />
                  </>
                ) : null}
                {row.actionable ? controls : fallbackControls}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
