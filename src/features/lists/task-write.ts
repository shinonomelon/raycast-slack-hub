import type { Session } from "../../slack/identity.ts";
import { object } from "../../slack/slack-api.ts";
import { runWrite, type WriteOutcome } from "../operations/write-outcome.ts";
import { fetchItemInfo, fetchItems } from "./lists-api.ts";
import {
  ITEM_ID,
  isSlackUrl,
  validDate,
  type SlackList,
  type TaskItem,
} from "./lists-model.ts";
import { VERIFIED_TASK_TYPES, taskCapabilities } from "./task-capabilities.ts";
export type TaskValues = {
  title: string;
  assigneeIds?: string[];
  dueDate?: string | null;
  completed?: boolean;
};
export type TaskRequest = {
  session: Session;
  list: SlackList;
  item?: TaskItem;
  values?: TaskValues;
  source?: string;
  kind: "create" | "update" | "delete" | "complete";
  verifiedTypes?: readonly string[];
  allowClearing?: boolean;
  isCurrent?: () => boolean;
};
export function textBlocks(
  title: string,
  source?: string,
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [{ type: "text", text: title }];
  if (source)
    elements.push(
      { type: "text", text: "\n" },
      { type: "link", url: source, text: "元メッセージ" },
    );
  return [
    { type: "rich_text", elements: [{ type: "rich_text_section", elements }] },
  ];
}
// 複雑なrich_textを平文に潰さず、先頭の素のタイトル文字列だけ編集できる形に限定する。
function safeExistingLink(value: string) {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function editableTitle(richText: unknown): string | undefined {
  if (!Array.isArray(richText) || richText.length !== 1) return undefined;
  const block = object(richText[0]);
  if (
    block.type !== "rich_text" ||
    !Array.isArray(block.elements) ||
    block.elements.length !== 1
  )
    return undefined;
  const section = object(block.elements[0]);
  if (
    section.type !== "rich_text_section" ||
    !Array.isArray(section.elements) ||
    section.elements.length === 0
  )
    return undefined;
  const [first, ...rest] = section.elements.map(object);
  if (
    first.type !== "text" ||
    typeof first.text !== "string" ||
    first.style !== undefined
  )
    return undefined;
  if (
    rest.some(
      (item) =>
        !(
          item.type === "link" &&
          typeof item.url === "string" &&
          safeExistingLink(item.url) &&
          item.style === undefined
        ) &&
        !(
          item.type === "text" &&
          item.text === "\n" &&
          item.style === undefined
        ),
    )
  )
    return undefined;
  return first.text;
}
export function replaceTitle(
  richText: unknown,
  title: string,
): Record<string, unknown>[] {
  if (editableTitle(richText) === undefined)
    throw new Error("このタイトルの書式は編集できません");
  const clone = structuredClone(richText) as Record<string, unknown>[];
  const elements = object((object(clone[0]).elements as unknown[])[0])
    .elements as Record<string, unknown>[];
  elements[0] = { ...elements[0], text: title };
  return clone;
}
export function taskChanged(initial: TaskItem, current: TaskItem): boolean {
  return (
    initial.updatedTimestamp !== current.updatedTimestamp ||
    JSON.stringify(initial.fields) !== JSON.stringify(current.fields) ||
    initial.archived !== current.archived
  );
}
function sameSchema(initial: SlackList, current: SlackList): boolean {
  return (
    initial.id === current.id &&
    current.editable &&
    JSON.stringify(initial.columns) === JSON.stringify(current.columns)
  );
}
function cellsFor(
  request: TaskRequest,
  list: SlackList,
): Record<string, unknown>[] {
  const capabilities = taskCapabilities(
    list,
    request.verifiedTypes ?? VERIFIED_TASK_TYPES,
  );
  if (request.kind === "complete") {
    if (
      !capabilities.completed ||
      request.item?.completed === undefined ||
      request.values?.completed === undefined
    )
      throw new Error("完了状態を確認できません");
    return [
      {
        column_id: capabilities.completed.id,
        checkbox: request.values.completed,
      },
    ];
  }
  const values = request.values;
  if (!values || !capabilities.primary || !values.title.trim())
    throw new Error("タイトルと対応するタイトル列が必要です");
  if (values.title.length > 3000)
    throw new Error("タイトルは3000文字以内にしてください");
  const cells: Record<string, unknown>[] = [];
  const prior = request.item;
  if (!prior || editableTitle(prior.richText) !== values.title) {
    const richText = prior
      ? replaceTitle(prior.richText, values.title)
      : textBlocks(
          values.title,
          request.source && !capabilities.message ? request.source : undefined,
        );
    cells.push({ column_id: capabilities.primary.id, rich_text: richText });
  }
  if (request.source && !prior && capabilities.message)
    cells.push({
      column_id: capabilities.message.id,
      message: [request.source],
    });
  if (
    values.assigneeIds !== undefined &&
    (!prior ||
      JSON.stringify(values.assigneeIds) !== JSON.stringify(prior.assigneeIds))
  ) {
    if (
      !capabilities.assignee ||
      !values.assigneeIds.every((id) => /^[UW][A-Z0-9]+$/.test(id))
    )
      throw new Error("担当者列またはIDを確認できません");
    if (prior && values.assigneeIds.length === 0 && !request.allowClearing)
      throw new Error("担当のクリア形式は実APIで未検証です");
    if (prior || values.assigneeIds.length > 0)
      cells.push({
        column_id: capabilities.assignee.id,
        user: values.assigneeIds,
      });
  }
  if (
    values.dueDate !== undefined &&
    (!prior || values.dueDate !== prior.dueDate)
  ) {
    if (
      !capabilities.due ||
      (values.dueDate !== null && !validDate(values.dueDate))
    )
      throw new Error("期限の列または日付を確認できません");
    if (prior && values.dueDate === null && !request.allowClearing)
      throw new Error("期限のクリア形式は実APIで未検証です");
    if (prior || values.dueDate !== null)
      cells.push({
        column_id: capabilities.due.id,
        date: values.dueDate ? [values.dueDate] : [],
      });
  }
  if (
    values.completed !== undefined &&
    (!prior || values.completed !== prior.completed)
  ) {
    if (!capabilities.completed) throw new Error("完了列を確認できません");
    cells.push({
      column_id: capabilities.completed.id,
      checkbox: values.completed,
    });
  }
  return cells;
}
export async function writeTask(request: TaskRequest): Promise<WriteOutcome> {
  let cells: Record<string, unknown>[] = [];
  try {
    if (
      request.isCurrent?.() === false ||
      !request.session.canFetch ||
      !request.list.editable
    )
      throw new Error("認証と編集権限を確認してください");
    if (request.item?.archived)
      throw new Error("アーカイブ済み項目は閲覧のみです");
    if (request.source && !isSlackUrl(request.source))
      throw new Error("出典URLがSlackのURLではありません");
    const api = request.session.api;
    const teamId = request.session.display.teamId;
    if (request.kind === "create") {
      const page = await fetchItems(api, teamId, request.list.id, {
        limit: 1,
        verifiedTypes: request.verifiedTypes,
      });
      if (!sameSchema(request.list, page.list))
        throw new Error(
          "列構成または編集権限が変わりました。再読込してください",
        );
      cells = cellsFor(request, page.list);
    } else {
      if (
        !request.item ||
        request.item.listId !== request.list.id ||
        !ITEM_ID.test(request.item.id)
      )
        throw new Error("更新対象が一致しません");
      const fresh = await fetchItemInfo(
        api,
        teamId,
        request.list.id,
        request.item.id,
        request.verifiedTypes,
      );
      if (
        !sameSchema(request.list, fresh.list) ||
        taskChanged(request.item, fresh.item) ||
        fresh.item.archived
      )
        throw new Error(
          "項目または列構成が変更されています。再読込して確認してください",
        );
      if (request.kind !== "delete") cells = cellsFor(request, fresh.list);
    }
  } catch (error) {
    // 直前読取の失敗は書込がまだ0回なので、結果未確認ではなく送信前の失敗。
    return {
      kind: "failed",
      message:
        error instanceof Error ? error.message : "送信前の確認に失敗しました",
    };
  }
  if (request.isCurrent?.() === false)
    return {
      kind: "failed",
      message: "認証または対象が変更されたため、送信を中止しました",
    };
  if (request.kind === "create") {
    const outcome = await runWrite(
      request.session.api,
      "slackLists.items.create",
      { list_id: request.list.id, initial_fields: cells },
      (raw) => {
        const item = object(raw.item);
        return (
          typeof item.id === "string" &&
          ITEM_ID.test(item.id) &&
          item.list_id === request.list.id
        );
      },
    );
    return outcome;
  }
  if (request.kind === "delete")
    return runWrite(request.session.api, "slackLists.items.delete", {
      list_id: request.list.id,
      id: request.item!.id,
    });
  if (cells.length === 0) return { kind: "succeeded", id: request.item!.id };
  return runWrite(request.session.api, "slackLists.items.update", {
    list_id: request.list.id,
    cells: cells.map((cell) => ({ ...cell, row_id: request.item!.id })),
  });
}
