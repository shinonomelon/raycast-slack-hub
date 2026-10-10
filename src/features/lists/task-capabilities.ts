import type { ListColumn, SlackList } from "./lists-model.ts";

// 実APIのG-002で確認できた型だけを出荷時に追加する。列名では意味を推測しない。
export const VERIFIED_TASK_TYPES: readonly string[] = [];
export type TaskCapabilities = {
  primary?: ListColumn;
  assignee?: ListColumn;
  due?: ListColumn;
  completed?: ListColumn;
  message?: ListColumn;
  reasons: string[];
};
export function taskCapabilities(
  list: SlackList,
  verifiedTypes = VERIFIED_TASK_TYPES,
): TaskCapabilities {
  const reasons: string[] = [];
  const unique = (columns: ListColumn[], label: string) => {
    if (columns.length !== 1) {
      reasons.push(`${label}列を一意に識別できません`);
      return undefined;
    }
    return columns[0];
  };
  const primary = unique(
    list.columns.filter((c) => c.primary && c.type === "text"),
    "タイトル",
  );
  const match = (types: string[], label: string) => {
    const candidates = list.columns.filter((c) => types.includes(c.type));
    // 未検証の候補も含めて重複を検査し、別系列を黙って無視しない。
    const column = unique(candidates, label);
    return column && verifiedTypes.includes(column.type) ? column : undefined;
  };
  const assignee = match(["assignee", "todo_assignee"], "担当");
  const due = match(["due_date", "todo_due_date"], "期限");
  const completed = match(["completed", "todo_completed"], "完了");
  const messages = list.columns.filter((c) => c.type === "message");
  const message = messages.length === 1 ? messages[0] : undefined;
  if (!list.editable) reasons.push("編集権限が確認できないため閲覧のみです");
  return { primary, assignee, due, completed, message, reasons };
}
