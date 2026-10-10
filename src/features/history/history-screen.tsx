import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useState } from "react";
import { messageLink, type Hit } from "../../slack/hits.ts";
import { MessageRow } from "../hub/message-row.tsx";
import { DETAILS_SHORTCUT } from "../hub/shortcuts.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { historyHit } from "./history-model.ts";
import { useHistory } from "./use-history.ts";
import { ThreadScreen } from "./thread-screen.tsx";
import type { HistoryMode } from "./history-controller.ts";

export function HistoryScreen({
  context,
  hit,
}: {
  context: MembershipContext;
  hit: Hit;
}) {
  if (!FEATURE_GATES.history[hit.channelKind])
    return <ApiGateNotice title="Surrounding Messages" />;
  return <HistoryView context={context} hit={hit} mode="history" />;
}
export function HistoryView({
  context,
  hit,
  mode,
}: {
  context: MembershipContext;
  hit: Hit;
  mode: HistoryMode;
}) {
  const state = useHistory(context.session, hit, mode);
  const [detail, setDetail] = useState(false);
  const [, redraw] = useState(0);
  const range = state.range;
  const time = (ts: string) =>
    new Date(Number(ts.split(".")[0]) * 1000).toLocaleString("ja-JP");
  const status = state.capped
    ? "500投稿・本文2MiBの上限です。範囲を狭めて開き直すか、Slackで確認してください"
    : (state.error ??
      (state.status === "loading"
        ? "読み込み中"
        : state.complete
          ? "この範囲の取得完了"
          : "この範囲は一部取得済み"));
  const common = (
    <>
      {state.status === "failed" ? (
        <Action
          title="Retry"
          icon={Icon.ArrowClockwise}
          onAction={state.retry}
        />
      ) : null}
      {state.cursor && !state.capped ? (
        <Action title="Load More" icon={Icon.Plus} onAction={state.more} />
      ) : null}
      {mode === "history" && state.complete ? (
        <>
          <Action title="Earlier Messages" onAction={state.earlier} />
          <Action title="Later Messages" onAction={state.later} />
        </>
      ) : null}
      {mode === "history" ? (
        <Action.Push
          title="View Thread"
          icon={Icon.SpeechBubble}
          target={<ThreadScreen context={context} hit={hit} />}
        />
      ) : null}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={state.refresh}
      />
    </>
  );
  const row = (
    source: Hit,
    id: string,
    fullText?: string,
    replyEnabled = false,
  ) => (
    <MessageRow
      key={id}
      id={id}
      session={context.session}
      hit={source}
      names={context.names}
      state={context.isMarked(source) ? "handled" : undefined}
      marked={context.isMarked(source)}
      showDetail={detail}
      onToggleDetail={() => setDetail((value) => !value)}
      conversationFilter={undefined}
      senderFilter={undefined}
      onFilter={() => {}}
      onOpen={() => {
        context.markOpened(source);
        redraw((value) => value + 1);
      }}
      onReplied={() => {
        context.markReplied(source);
        redraw((value) => value + 1);
      }}
      onToggleHandled={() => {
        context.toggleHandled(source);
        redraw((value) => value + 1);
      }}
      detailText={fullText}
      replyEnabled={replyEnabled}
      membershipContext={context}
      common={common}
    />
  );
  return (
    <List
      navigationTitle={mode === "history" ? "Surrounding Messages" : "Thread"}
      isLoading={state.status === "loading"}
      isShowingDetail={detail}
      filtering={false}
      searchBarPlaceholder="Actionsから追加取得できます"
    >
      <List.EmptyView
        title={status}
        actions={
          <ActionPanel>
            <Action.Open
              title="Open in Slack"
              target={messageLink(context.session.display.teamId, hit)}
              application="Slack"
            />
            {common}
          </ActionPanel>
        }
      />
      <List.Section
        title="検索時点のプレビュー"
        subtitle="返信の現行本文はView Threadで取得"
      >
        {row(hit, `source:${hit.channelId}:${hit.ts}`)}
      </List.Section>
      <List.Section
        title={
          mode === "history" ? "取得済みのチャンネル投稿" : "取得済みの親と返信"
        }
        subtitle={status}
      >
        {state.messages.map((message) => {
          const source = historyHit(
            message,
            hit,
            context.session.display.userId,
            mode === "thread" ? state.parentTs : undefined,
          );
          if (message.ts === hit.ts)
            source.text = `選択した投稿 · ${source.text}`;
          return row(
            source,
            source.key,
            message.fullText,
            mode === "thread" && !!state.parentTs,
          );
        })}
      </List.Section>
      <List.Item
        id="history-status"
        title="取得状況"
        subtitle={status}
        detail={
          <List.Item.Detail
            markdown={[
              status,
              range
                ? `取得範囲: ${time(range.oldest)} 〜 ${time(range.latest)}`
                : "取得範囲は未確認",
              state.limited
                ? "Slackの履歴制限があります。保管期限外の投稿は確認できません"
                : "保管期限・アクセス権により過去の投稿を取得できない場合があります",
            ].join("\n\n")}
          />
        }
        actions={
          <ActionPanel>
            <Action.Open
              title="Open in Slack"
              target={messageLink(context.session.display.teamId, hit)}
              application="Slack"
            />
            <Action
              title={detail ? "Hide Details" : "Show Details"}
              icon={Icon.Sidebar}
              shortcut={DETAILS_SHORTCUT}
              onAction={() => setDetail((value) => !value)}
            />
            {common}
          </ActionPanel>
        }
      />
    </List>
  );
}
