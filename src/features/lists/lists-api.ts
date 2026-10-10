import { object, type ApiCall } from "../../slack/slack-api.ts";
import {
  LIST_ID,
  readList,
  readItem,
  type SlackList,
  type TaskItem,
} from "./lists-model.ts";
import { VERIFIED_TASK_TYPES, taskCapabilities } from "./task-capabilities.ts";
export type ItemsPage = { list: SlackList; items: TaskItem[]; cursor: string };
export async function fetchItems(
  api: ApiCall,
  teamId: string,
  listId: string,
  {
    cursor = "",
    archived = false,
    limit = 100,
    signal,
    verifiedTypes = VERIFIED_TASK_TYPES,
  }: {
    cursor?: string;
    archived?: boolean;
    limit?: number;
    signal?: AbortSignal;
    verifiedTypes?: readonly string[];
  } = {},
): Promise<ItemsPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("項目の取得数は1〜100です");
  if (!LIST_ID.test(listId)) throw new Error("リストIDが不正です");
  const raw = await api(
    "slackLists.items.list",
    {
      list_id: listId,
      limit,
      include_list: true,
      archived,
      ...(cursor ? { cursor } : {}),
    },
    { signal },
  );
  const list = readList(raw.list, teamId, listId);
  if (!Array.isArray(raw.items))
    throw new Error("リスト項目の応答を読み取れませんでした");
  const metadata = object(raw.response_metadata);
  if (
    metadata.next_cursor !== undefined &&
    typeof metadata.next_cursor !== "string"
  )
    throw new Error("ページ情報を読み取れませんでした");
  const capabilities = taskCapabilities(list, verifiedTypes);
  return {
    list,
    items: raw.items.map((item) =>
      readItem(item, list, archived, capabilities),
    ),
    cursor:
      typeof metadata.next_cursor === "string"
        ? metadata.next_cursor.trim()
        : "",
  };
}
export async function fetchItemInfo(
  api: ApiCall,
  teamId: string,
  listId: string,
  id: string,
  verifiedTypes = VERIFIED_TASK_TYPES,
): Promise<{ list: SlackList; item: TaskItem }> {
  const raw = await api("slackLists.items.info", { list_id: listId, id });
  const list = readList(raw.list, teamId, listId);
  const item = readItem(
    raw.record,
    list,
    false,
    taskCapabilities(list, verifiedTypes),
  );
  if (item.id !== id) throw new Error("更新対象の項目IDが一致しません");
  return { list, item };
}
