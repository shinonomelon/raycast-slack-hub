import {
  Action,
  ActionPanel,
  Icon,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useState } from "react";
import type { Conversation } from "../../shared/types.ts";
import { DETAILS_SHORTCUT } from "../hub/shortcuts.ts";
import { MessageRow } from "../hub/message-row.tsx";
import { textWithFilter } from "../hub/view-order.ts";
import { useMessageSearch } from "../search/use-message-search.ts";
import type { MembershipContext } from "./membership-context.ts";
export function ConversationMessages({
  context,
  channel,
}: {
  context: MembershipContext;
  channel: Conversation;
}) {
  const [text, setText] = useState("");
  const [detail, setDetail] = useState(false);
  const [, redraw] = useState(0);
  const expression = `in:<#${channel.id}>${text.trim() ? ` ${text.trim()}` : ""}`;
  const search = useMessageSearch(expression, context.session);
  const hits =
    context.session.canFetch && search.query === expression ? search.hits : [];
  const common = (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={search.revalidate}
      />
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
  const status = !context.session.canFetch
    ? "認証を確認し、Hubを開き直してください"
    : search.status?.query === expression && search.status.kind === "failed"
      ? search.status.message
      : search.status?.query === expression && search.status.kind === "paused"
        ? `検索を一時停止しています（${new Date(search.status.pause.until).toLocaleTimeString("ja-JP")}まで）`
        : search.isLoading
          ? "検索中"
          : "このチャンネルに一致するメッセージがありません";
  return (
    <List
      navigationTitle={`#${channel.name} 内を検索`}
      searchBarPlaceholder="このチャンネル内のメッセージを検索"
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isLoading={search.isLoading}
      isShowingDetail={detail}
    >
      <List.EmptyView
        title={status}
        description={`検索先: #${channel.name}`}
        actions={
          <ActionPanel>
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              onAction={search.revalidate}
            />
            {detail ? (
              <Action
                title="Hide Details"
                icon={Icon.Sidebar}
                shortcut={DETAILS_SHORTCUT}
                onAction={() => setDetail(false)}
              />
            ) : null}
            <Action
              title="Open Extension Preferences"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel>
        }
      />
      {hits.map((hit) => (
        <MessageRow
          key={hit.key}
          id={hit.key}
          session={context.session}
          hit={hit}
          names={context.names}
          state={context.isMarked(hit) ? "handled" : undefined}
          marked={context.isMarked(hit)}
          showDetail={detail}
          onToggleDetail={() => setDetail((value) => !value)}
          conversationFilter={undefined}
          senderFilter={
            context.names.handleOf(hit.userId)
              ? `from:<@${hit.userId}>`
              : undefined
          }
          onFilter={(filter) =>
            setText((current) => textWithFilter(current, filter, "message"))
          }
          onOpen={() => {
            context.markOpened(hit);
            redraw((value) => value + 1);
          }}
          onReplied={() => {
            context.markReplied(hit);
            redraw((value) => value + 1);
          }}
          onToggleHandled={() => {
            context.toggleHandled(hit);
            redraw((value) => value + 1);
          }}
          membershipContext={context}
          common={common}
        />
      ))}
    </List>
  );
}
