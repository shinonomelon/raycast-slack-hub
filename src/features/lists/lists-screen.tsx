import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useState } from "react";
import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { DETAILS_SHORTCUT } from "../hub/shortcuts.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { rankLists } from "./list-discovery.ts";
import { escapeMarkdown } from "./lists-model.ts";
import { useLists } from "./use-lists.ts";
import { ListItemsScreen } from "./list-items-screen.tsx";
import { OpenListForm } from "./open-list-form.tsx";
import { TaskPreparation } from "./task-preparation.tsx";
export function ListsScreen({ context }: { context: MembershipContext }) {
  if (!FEATURE_GATES.listsRead) return <ApiGateNotice title="Slack Lists" />;
  return <ListsBrowser context={context} />;
}
export function ListsBrowser({
  context,
  hit,
}: {
  context: MembershipContext;
  hit?: Hit;
}) {
  const [text, setText] = useState("");
  const [detail, setDetail] = useState(false);
  const { state, loadMore, refresh } = useLists(context.session);
  const lists = rankLists(state.lists, text);
  const common = (
    <>
      <Action.Push
        title="Open List by URL or ID"
        icon={Icon.Link}
        target={<OpenListForm context={context} hit={hit} />}
      />
      {state.hasMore && !state.capped && !state.busy && (
        <Action
          title="Load More"
          icon={Icon.Plus}
          onAction={() => void loadMore()}
        />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={() => void refresh()}
      />
    </>
  );
  const status = !context.session.canFetch
    ? "認証を確認してHubを開き直してください"
    : (state.error ?? (state.busy ? "取得中" : "取得済みのリストに一致なし"));
  const summary = `取得済み${state.lists.length}件 / 検索結果${state.total}件${state.capped ? "（取得上限）" : state.hasMore ? "（取得途中）" : ""}。検索設定やアクセス権による未表示があります`;
  return (
    <List
      navigationTitle={hit ? "タスクの保存先を選択" : "Slack Lists"}
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isLoading={state.busy}
      isShowingDetail={!hit && detail}
      searchBarPlaceholder="取得済みリストの名前で検索"
    >
      <List.EmptyView
        title={status}
        description={summary}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      <List.Section title={summary} subtitle={state.error}>
        {lists.map((list) => (
          <List.Item
            id={list.id}
            key={list.id}
            title={list.title}
            icon={Icon.List}
            detail={
              <List.Item.Detail
                markdown={`# ${escapeMarkdown(list.title)}\n\nID: ${list.id}\n\n検索で取得したリスト。編集権限と列構成はView Itemsで確認します。`}
              />
            }
            actions={
              <ActionPanel>
                {hit ? (
                  <Action.Push
                    title="Select List"
                    icon={Icon.Checkmark}
                    target={
                      <TaskPreparation
                        context={context}
                        listId={list.id}
                        hit={hit}
                      />
                    }
                  />
                ) : (
                  <>
                    <Action.Open title="Open List in Slack" target={list.url} />
                    <Action
                      title={detail ? "Hide Details" : "Show Details"}
                      icon={Icon.Sidebar}
                      shortcut={DETAILS_SHORTCUT}
                      onAction={() => setDetail(!detail)}
                    />
                    <Action.Push
                      title="View Items"
                      icon={Icon.List}
                      target={
                        <ListItemsScreen context={context} listId={list.id} />
                      }
                    />
                  </>
                )}
                {common}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
