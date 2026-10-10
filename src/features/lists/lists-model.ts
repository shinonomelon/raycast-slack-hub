import { object } from "../../slack/slack-api.ts";
import {
  taskCapabilities,
  type TaskCapabilities,
} from "./task-capabilities.ts";

export const LIST_ID = /^F[A-Z0-9]+$/;
export const ITEM_ID = /^Rec[A-Za-z0-9]+$/;
export type ListColumn = { id: string; type: string; primary: boolean };
export type SlackList = {
  id: string;
  title: string;
  editable: boolean;
  columns: ListColumn[];
  url: string;
};
export type TaskItem = {
  id: string;
  listId: string;
  title: string;
  richText: unknown;
  assigneeIds: string[] | undefined;
  dueDate: string | null | undefined;
  completed: boolean | undefined;
  parentRecordId?: string;
  archived: boolean;
  updatedTimestamp?: string;
  fields: Record<string, unknown>[];
  url?: string;
};
export function slackListUrl(teamId: string, listId: string): string {
  return `https://app.slack.com/lists/${encodeURIComponent(teamId)}/${encodeURIComponent(listId)}`;
}
export function isSlackUrl(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}
export function readList(
  raw: unknown,
  teamId: string,
  expectedId?: string,
): SlackList {
  const list = object(raw);
  if (
    typeof list.id !== "string" ||
    !LIST_ID.test(list.id) ||
    (expectedId && list.id !== expectedId)
  )
    throw new Error("リストIDを確認できませんでした");
  const schema = object(list.list_metadata).schema;
  if (!Array.isArray(schema))
    throw new Error("リストのスキーマを確認できませんでした");
  const columns: ListColumn[] = schema.map((value) => {
    const column = object(value);
    if (
      typeof column.id !== "string" ||
      !/^Col[A-Za-z0-9]+$/.test(column.id) ||
      typeof column.type !== "string"
    )
      throw new Error("列の型を確認できませんでした");
    return {
      id: column.id,
      type: column.type,
      primary: column.is_primary_column === true,
    };
  });
  if (new Set(columns.map((c) => c.id)).size !== columns.length)
    throw new Error("リストに重複した列IDがあります");
  return {
    id: list.id,
    title:
      typeof list.title === "string"
        ? list.title
        : typeof list.name === "string"
          ? list.name
          : list.id,
    editable: list.editable === true,
    columns,
    url: slackListUrl(teamId, list.id),
  };
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function richTextPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const walk = (node: unknown): string => {
    const item = object(node);
    if (item.type === "text")
      return typeof item.text === "string" ? item.text : "";
    if (item.type === "link")
      return typeof item.text === "string"
        ? item.text
        : typeof item.url === "string"
          ? item.url
          : "";
    if (item.type === "user")
      return typeof item.user_id === "string" ? `@${item.user_id}` : "";
    return Array.isArray(item.elements)
      ? item.elements.map(walk).join(item.type === "rich_text" ? "\n" : "")
      : "";
  };
  return value.map(walk).join("\n");
}
function fieldFor(fields: Record<string, unknown>[], column?: ListColumn) {
  if (!column) return undefined;
  const values = fields.filter((f) => f.column_id === column.id);
  return values.length === 0 ? {} : values.length === 1 ? values[0] : undefined;
}
export function readItem(
  raw: unknown,
  list: SlackList,
  archived = false,
  capabilities: TaskCapabilities = taskCapabilities(list),
): TaskItem {
  const record = object(raw);
  if (
    typeof record.id !== "string" ||
    !ITEM_ID.test(record.id) ||
    record.list_id !== list.id ||
    !Array.isArray(record.fields)
  )
    throw new Error("リスト項目の対象を確認できませんでした");
  const fields = record.fields.map(object);
  const titleField = fieldFor(fields, capabilities.primary);
  const richText = titleField?.rich_text;
  const title =
    richTextPlain(richText) ||
    (typeof titleField?.text === "string" ? titleField.text : "") ||
    record.id;
  const assigned = fieldFor(fields, capabilities.assignee);
  const users = assigned?.user;
  const assigneeIds = !assigned
    ? undefined
    : users === undefined
      ? assigned.value === undefined ||
        assigned.value === "" ||
        assigned.value === null
        ? []
        : undefined
      : Array.isArray(users) &&
          users.every((u) => typeof u === "string" && /^[UW][A-Z0-9]+$/.test(u))
        ? (users as string[])
        : undefined;
  const complete = fieldFor(fields, capabilities.completed);
  const checkbox = complete?.checkbox;
  const completed = !complete
    ? undefined
    : checkbox === undefined
      ? complete.value === undefined ||
        complete.value === "" ||
        complete.value === null
        ? false
        : undefined
      : typeof checkbox === "boolean"
        ? checkbox
        : Array.isArray(checkbox) &&
            checkbox.length === 1 &&
            typeof checkbox[0] === "boolean"
          ? checkbox[0]
          : undefined;
  const due = fieldFor(fields, capabilities.due);
  const dates = due?.date;
  const dueDate = !due
    ? undefined
    : dates === undefined
      ? due.value === undefined || due.value === "" || due.value === null
        ? null
        : undefined
      : Array.isArray(dates) && dates.length === 0
        ? null
        : Array.isArray(dates) && dates.length === 1 && validDate(dates[0])
          ? dates[0]
          : undefined;
  const permalink = isSlackUrl(record.permalink) ? record.permalink : undefined;
  return {
    id: record.id,
    listId: list.id,
    title,
    richText,
    assigneeIds,
    completed,
    dueDate,
    fields,
    parentRecordId:
      typeof record.parent_record_id === "string"
        ? record.parent_record_id
        : undefined,
    archived:
      archived || record.is_archived === true || record.archived === true,
    updatedTimestamp:
      typeof record.updated_timestamp === "string"
        ? record.updated_timestamp
        : undefined,
    url: permalink,
  };
}
export type ItemFilter = {
  assignee: string;
  status: "all" | "complete" | "incomplete";
};
export const ALL_ITEMS: ItemFilter = { assignee: "", status: "all" };
export function filterItems(
  items: readonly TaskItem[],
  filter: ItemFilter,
): TaskItem[] {
  return items.filter(
    (item) =>
      (!filter.assignee || item.assigneeIds?.includes(filter.assignee)) &&
      (filter.status === "all" ||
        item.completed === (filter.status === "complete")),
  );
}
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!<>|]/g, "\\$&");
}
export function itemDetails(item: TaskItem): string {
  return `# ${escapeMarkdown(item.title)}\n\n担当: ${escapeMarkdown(item.assigneeIds?.join(", ") ?? "判定できない")}\n\n期限: ${item.dueDate ?? "なし/判定できない"}\n\n状態: ${item.completed === undefined ? "判定できない" : item.completed ? "完了" : "未完了"}\n\n${item.parentRecordId ? "子項目\n\n" : ""}${item.archived ? "アーカイブ済み（閲覧のみ）\n\n" : ""}項目ID: ${item.id}\n\nリストID: ${item.listId}`;
}
