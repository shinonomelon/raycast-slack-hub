import { useThreadContext } from "../hub/use-thread-context.ts";
import { t, getLocale } from "../../shared/i18n.ts";
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
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const expression = `in:<#${channel.id}>${text.trim() ? ` ${text.trim()}` : ""}`;
  const search = useMessageSearch(expression, context.session);
  const hits =
    context.session.canFetch && search.query === expression ? search.hits : [];
  const threadDetail = useThreadContext(
    context.session,
    hits.find((hit) => hit.key === activeRowId),
    detail,
  );
  const common = (
    <>
      <Action
        title={t("Refresh")}
        icon={Icon.ArrowClockwise}
        onAction={search.revalidate}
      />
      <Action
        title={t("Open Extension Preferences")}
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
  const status = !context.session.canFetch
    ? t("認証を確認し、Hubを開き直してください")
    : search.status?.query === expression && search.status.kind === "failed"
      ? search.status.message
      : search.status?.query === expression && search.status.kind === "paused"
        ? t(
            "検索を一時停止しています（{0}まで）",
            new Date(search.status.pause.until).toLocaleTimeString(getLocale()),
          )
        : search.isLoading
          ? t("検索中")
          : t("このチャンネルに一致するメッセージがありません");
  return (
    <List
      navigationTitle={t("#{0} 内を検索", channel.name)}
      searchBarPlaceholder={t("このチャンネル内のメッセージを検索")}
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isLoading={search.isLoading}
      isShowingDetail={detail}
      onSelectionChange={setActiveRowId}
    >
      <List.EmptyView
        title={status}
        description={t("検索先: #{0}", channel.name)}
        actions={
          <ActionPanel>
            <Action
              title={t("Refresh")}
              icon={Icon.ArrowClockwise}
              onAction={search.revalidate}
            />
            {detail ? (
              <Action
                title={t("Hide Details")}
                icon={Icon.Sidebar}
                shortcut={DETAILS_SHORTCUT}
                onAction={() => setDetail(false)}
              />
            ) : null}
            <Action
              title={t("Open Extension Preferences")}
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
          threadDetail={
            detail && hit.key === activeRowId ? threadDetail : undefined
          }
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
