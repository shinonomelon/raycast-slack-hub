import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Icon,
  List,
} from "@raycast/api";
import { useRef, useState } from "react";
import type { MembershipContext } from "../membership/membership-context.ts";
import { DETAILS_SHORTCUT } from "../hub/shortcuts.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { useWriteOperation } from "../operations/use-write-operation.ts";
import { rankItems } from "../search/search.ts";
import {
  ALL_ITEMS,
  filterItems,
  itemDetails,
  slackListUrl,
  type ItemFilter,
  type TaskItem,
} from "./lists-model.ts";
import { useListItems } from "./use-lists.ts";
import { taskCapabilities } from "./task-capabilities.ts";
import { editableTitle, writeTask } from "./task-write.ts";
import { TaskForm } from "./task-form.tsx";
import { ItemFilterForm } from "./item-filter-form.tsx";
export function ListItemsScreen({
  context,
  listId,
}: {
  context: MembershipContext;
  listId: string;
}) {
  if (!FEATURE_GATES.listsRead)
    return <ApiGateNotice title="Slack List Items" />;
  return <ItemsBrowser context={context} listId={listId} />;
}
function ItemsBrowser({
  context,
  listId,
}: {
  context: MembershipContext;
  listId: string;
}) {
  const [text, setText] = useState("");
  const [detail, setDetail] = useState(false);
  const [archived, setArchived] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [filter, setFilter] = useState<ItemFilter>(ALL_ITEMS);
  const { state, loadMore, refresh, refreshAfterWrite } = useListItems(
    context.session,
    listId,
    archived,
  );
  const operation = useWriteOperation(context.session);
  const confirming = useRef(false);
  const current = useRef({
    api: context.session.api,
    stamp: `${context.session.display.teamId}:${context.session.display.userId}:${context.session.canFetch}:${listId}:${archived}`,
  });
  current.current = {
    api: context.session.api,
    stamp: `${context.session.display.teamId}:${context.session.display.userId}:${context.session.canFetch}:${listId}:${archived}`,
  };
  const list = state.list;
  const capabilities = list ? taskCapabilities(list) : undefined;
  const items = rankItems(
    filterItems(state.items, filter).map((item) => ({
      ...item,
      kind: "channel" as const,
      keywords: [item.title],
    })),
    text,
    state.items.length,
  );
  const url = list?.url ?? slackListUrl(context.session.display.teamId, listId);
  async function change(item: TaskItem, kind: "complete" | "delete") {
    if (
      !list ||
      !FEATURE_GATES.listsWrite ||
      !list.editable ||
      archived ||
      item.archived ||
      operation.busy ||
      operation.unconfirmed ||
      unconfirmed ||
      confirming.current
    )
      return;
    const owner = current.current;
    confirming.current = true;
    try {
      if (
        kind === "delete" &&
        !(await confirmAlert({
          title: "タスクを削除しますか？",
          message: `${list.title} (${list.id})\n${item.title} (${item.id})`,
          primaryAction: {
            title: "Delete Task",
            style: Alert.ActionStyle.Destructive,
          },
        }))
      )
        return;
      const outcome = await operation.run(() =>
        writeTask({
          session: context.session,
          isCurrent: () =>
            current.current.api === owner.api &&
            current.current.stamp === owner.stamp,
          list,
          item,
          kind,
          ...(kind === "complete"
            ? { values: { title: item.title, completed: !item.completed } }
            : {}),
        }),
      );
      if (outcome && outcome.kind !== "failed") void refresh();
    } finally {
      confirming.current = false;
    }
  }
  const common = (
    <>
      {list && capabilities && (
        <>
          {(capabilities.assignee || capabilities.completed) && (
            <Action.Push
              title="Filter Items"
              icon={Icon.Filter}
              target={
                <ItemFilterForm
                  context={context}
                  filter={filter}
                  capabilities={capabilities}
                  onApply={setFilter}
                />
              }
            />
          )}
          {capabilities.assignee && capabilities.completed && (
            <Action
              title="My Incomplete Tasks"
              icon={Icon.Person}
              onAction={() =>
                setFilter({
                  assignee: context.session.display.userId,
                  status: "incomplete",
                })
              }
            />
          )}
          <Action title="Clear Filters" onAction={() => setFilter(ALL_ITEMS)} />
          {!archived &&
            list.editable &&
            capabilities.primary &&
            FEATURE_GATES.listsWrite &&
            !unconfirmed &&
            !operation.unconfirmed && (
              <Action.Push
                title="Add Task"
                icon={Icon.Plus}
                target={
                  <TaskForm
                    context={context}
                    list={list}
                    onSaved={async (outcome) => {
                      if (
                        current.current.api !== context.session.api ||
                        current.current.stamp !==
                          `${context.session.display.teamId}:${context.session.display.userId}:${context.session.canFetch}:${listId}:${archived}`
                      )
                        return;
                      if (outcome.kind === "unconfirmed") setUnconfirmed(true);
                      await refreshAfterWrite();
                    }}
                  />
                }
              />
            )}
        </>
      )}
      {state.cursor && !state.capped && !state.busy && (
        <Action
          title="Load More"
          icon={Icon.Plus}
          onAction={() => void loadMore()}
        />
      )}
      <Action
        title={archived ? "Show Active Items" : "Show Archived Items"}
        icon={Icon.Box}
        onAction={() => setArchived(!archived)}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={() => void refresh()}
      />
    </>
  );
  const scope = state.capped
    ? "取得上限（10,000件/2MiB）。Slackで検索してください"
    : state.cursor
      ? "取得途中・読み込み済み項目だけを検索"
      : state.loaded
        ? "このリストの取得完了"
        : "未取得";
  const status = !context.session.canFetch
    ? "認証を確認しHubを開き直してください"
    : (state.error ??
      (state.busy
        ? "取得中"
        : state.cursor || !state.loaded || state.capped
          ? "読み込み済み項目に一致なし"
          : "このリストに一致する項目なし"));
  return (
    <List
      navigationTitle={`${list?.title ?? listId}${archived ? "・アーカイブ" : ""}`}
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isLoading={state.busy || operation.busy}
      isShowingDetail={detail}
      searchBarPlaceholder="読み込み済み項目の名前で検索"
    >
      <List.EmptyView
        title={status}
        description={scope}
        actions={
          <ActionPanel>
            <Action.Open title="Open List in Slack" target={url} />
            {common}
          </ActionPanel>
        }
      />
      <List.Section
        title={`${items.length}件一致 / ${state.items.length}件取得済み・${scope}`}
        subtitle={
          state.error ??
          (unconfirmed
            ? "変更結果は未確認です。Slackで対象を確認してください。"
            : capabilities?.reasons.join("・"))
        }
      >
        {items.map((item) => (
          <List.Item
            id={item.id}
            key={item.id}
            title={item.title}
            subtitle={item.parentRecordId ? "子項目" : undefined}
            icon={item.completed ? Icon.CheckCircle : Icon.Circle}
            accessories={[
              ...(item.dueDate ? [{ text: item.dueDate }] : []),
              ...(item.archived ? [{ text: "アーカイブ" }] : []),
            ]}
            detail={<List.Item.Detail markdown={itemDetails(item)} />}
            actions={
              <ActionPanel>
                <Action.Open
                  title={item.url ? "Open Item in Slack" : "Open List in Slack"}
                  target={item.url ?? url}
                />
                <Action
                  title={detail ? "Hide Details" : "Show Details"}
                  icon={Icon.Sidebar}
                  shortcut={DETAILS_SHORTCUT}
                  onAction={() => setDetail(!detail)}
                />
                {!archived &&
                  !item.archived &&
                  list?.editable &&
                  FEATURE_GATES.listsWrite &&
                  !operation.unconfirmed &&
                  !unconfirmed && (
                    <>
                      {capabilities?.primary &&
                        editableTitle(item.richText) !== undefined && (
                          <Action.Push
                            title="Edit Task"
                            icon={Icon.Pencil}
                            target={
                              <TaskForm
                                context={context}
                                list={list}
                                item={item}
                                onSaved={async (outcome) => {
                                  if (
                                    current.current.api !==
                                      context.session.api ||
                                    current.current.stamp !==
                                      `${context.session.display.teamId}:${context.session.display.userId}:${context.session.canFetch}:${listId}:${archived}`
                                  )
                                    return;
                                  if (outcome.kind === "unconfirmed")
                                    setUnconfirmed(true);
                                  await refreshAfterWrite();
                                }}
                              />
                            }
                          />
                        )}
                      {capabilities?.completed &&
                        item.completed !== undefined && (
                          <Action
                            title={
                              item.completed
                                ? "Mark Incomplete"
                                : "Mark Complete"
                            }
                            icon={Icon.Checkmark}
                            onAction={() => void change(item, "complete")}
                          />
                        )}
                      <Action
                        title="Delete Task"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        onAction={() => void change(item, "delete")}
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
