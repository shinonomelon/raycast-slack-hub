import type { ApiCall } from "../../slack/slack-api.ts";
import type { Session } from "../../slack/identity.ts";
import { readList, readItem } from "./lists-model.ts";
import { taskCapabilities } from "./task-capabilities.ts";
import { textBlocks } from "./task-write.ts";
export const VERIFIED = ["assignee", "due_date", "completed"];
export const RAW_LIST = {
  id: "FTEST",
  title: "Sprint",
  editable: true,
  list_metadata: {
    schema: [
      { id: "ColTitle", type: "text", is_primary_column: true },
      { id: "ColAssignee", type: "assignee" },
      { id: "ColDue", type: "due_date" },
      { id: "ColDone", type: "completed" },
      { id: "ColExtra", type: "number" },
    ],
  },
};
export const fixtureList = () => readList(RAW_LIST, "TTEST");
export function rawItem(id = "RecTEST", extra: Record<string, unknown> = {}) {
  return {
    id,
    list_id: "FTEST",
    updated_timestamp: "100.1",
    fields: [
      {
        column_id: "ColTitle",
        rich_text: textBlocks(
          "Task",
          "https://test.slack.com/archives/CTEST/p1790967145033309",
        ),
      },
      { column_id: "ColAssignee", user: ["UTEST"] },
      { column_id: "ColDue", date: ["2026-10-10"] },
      { column_id: "ColDone", checkbox: false },
      { column_id: "ColExtra", number: [42] },
    ],
    ...extra,
  };
}
export function fixtureItem() {
  const list = fixtureList();
  return readItem(rawItem(), list, false, taskCapabilities(list, VERIFIED));
}
export function fixtureSession(api: ApiCall): Session {
  const identity = {
    userId: "UTEST",
    teamId: "TTEST",
    user: "test",
    team: "Test",
    url: "https://test.slack.com",
  };
  return { api, canFetch: true, display: identity, fetchAs: identity };
}
