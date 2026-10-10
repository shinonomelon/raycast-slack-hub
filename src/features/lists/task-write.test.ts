import test from "node:test";
import assert from "node:assert/strict";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import {
  editableTitle,
  replaceTitle,
  textBlocks,
  writeTask,
} from "./task-write.ts";
import {
  fixtureItem,
  fixtureList,
  fixtureSession,
  RAW_LIST,
  rawItem,
  VERIFIED,
} from "./test-fixtures.ts";
function harness({
  list = RAW_LIST,
  record = rawItem(),
  error,
  response,
}: {
  list?: unknown;
  record?: unknown;
  error?: Error;
  response?: Record<string, unknown>;
} = {}) {
  const writes: { method: string; params: unknown }[] = [];
  const api: ApiCall = async (method, params) => {
    if (method === "slackLists.items.list")
      return {
        ok: true,
        list,
        items: [],
        response_metadata: { next_cursor: "" },
      };
    if (method === "slackLists.items.info") return { ok: true, list, record };
    writes.push({ method, params });
    if (error) throw error;
    return (
      response ??
      (method === "slackLists.items.create"
        ? { ok: true, item: { id: "RecNEW", list_id: "FTEST" } }
        : { ok: true })
    );
  };
  return { writes, session: fixtureSession(api) };
}
test("作成は直前schema検査しrich_textとtyped fieldsだけ送る", async () => {
  const { session, writes } = harness();
  const result = await writeTask({
    session,
    list: fixtureList(),
    kind: "create",
    verifiedTypes: VERIFIED,
    values: {
      title: "New",
      assigneeIds: ["UTEST"],
      dueDate: "2026-10-11",
      completed: false,
    },
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(result.kind === "succeeded" && result.id, "RecNEW");
  const sent = writes[0].params as {
    list_id: string;
    initial_fields: Record<string, unknown>[];
  };
  assert.equal(sent.list_id, "FTEST");
  assert.equal(sent.initial_fields.length, 4);
  assert.deepEqual(sent.initial_fields[0], {
    column_id: "ColTitle",
    rich_text: textBlocks("New"),
  });
  assert.deepEqual(sent.initial_fields[1], {
    column_id: "ColAssignee",
    user: ["UTEST"],
  });
  assert.deepEqual(sent.initial_fields[2], {
    column_id: "ColDue",
    date: ["2026-10-11"],
  });
  assert.deepEqual(sent.initial_fields[3], {
    column_id: "ColDone",
    checkbox: false,
  });
});
test("タイトル編集は既存リンクを保持し差分1セルだけ", async () => {
  const { session, writes } = harness();
  const item = fixtureItem();
  const result = await writeTask({
    session,
    list: fixtureList(),
    item,
    kind: "update",
    verifiedTypes: VERIFIED,
    values: {
      title: "Edited",
      assigneeIds: item.assigneeIds,
      dueDate: item.dueDate,
      completed: item.completed,
    },
  });
  assert.equal(result.kind, "succeeded");
  const sent = writes[0].params as { cells: Record<string, unknown>[] };
  assert.equal(sent.cells.length, 1);
  assert.equal(sent.cells[0].column_id, "ColTitle");
  assert.equal(sent.cells[0].row_id, "RecTEST");
  assert.match(JSON.stringify(sent.cells[0].rich_text), /元メッセージ/);
  assert.match(JSON.stringify(sent.cells[0].rich_text), /p1790967145033309/);
  assert.equal(JSON.stringify(sent).includes("ColExtra"), false);
});
test("completeはprimary列の編集可否に依存せず完了列だけ", async () => {
  const { session, writes } = harness();
  const result = await writeTask({
    session,
    list: fixtureList(),
    item: fixtureItem(),
    kind: "complete",
    verifiedTypes: VERIFIED,
    values: { title: "", completed: true },
  });
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(writes[0].params, {
    list_id: "FTEST",
    cells: [{ column_id: "ColDone", row_id: "RecTEST", checkbox: true }],
  });
});
test("削除は直前存在確認後に指定項目だけ", async () => {
  const { session, writes } = harness();
  const result = await writeTask({
    session,
    list: fixtureList(),
    item: fixtureItem(),
    kind: "delete",
  });
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(writes, [
    {
      method: "slackLists.items.delete",
      params: { list_id: "FTEST", id: "RecTEST" },
    },
  ]);
});
test("変更なしは書込0回", async () => {
  const { session, writes } = harness();
  const result = await writeTask({
    session,
    list: fixtureList(),
    item: fixtureItem(),
    kind: "update",
    values: { title: "Task" },
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(writes.length, 0);
});
for (const kind of ["create", "update", "complete", "delete"] as const) {
  test(`${kind}: schemaの列変更・権限変更では書込0回`, async () => {
    const { session, writes } = harness({
      list: { ...RAW_LIST, editable: false },
    });
    const result = await writeTask({
      session,
      list: fixtureList(),
      item: kind === "create" ? undefined : fixtureItem(),
      kind,
      verifiedTypes: VERIFIED,
      values: { title: "New", completed: true },
    });
    assert.equal(result.kind, "failed");
    assert.equal(writes.length, 0);
  });
}
test("updated timestamp・値競合・違うIDで書込0回", async () => {
  for (const record of [
    rawItem("RecTEST", { updated_timestamp: "200.2" }),
    rawItem("RecOTHER"),
    rawItem("RecTEST", { fields: [] }),
  ]) {
    const { session, writes } = harness({ record });
    const result = await writeTask({
      session,
      list: fixtureList(),
      item: fixtureItem(),
      kind: "update",
      values: { title: "New" },
    });
    assert.equal(result.kind, "failed");
    assert.equal(writes.length, 0);
  }
});
test("アーカイブ済み、認証未確認、対応不可rich_textの書込は0回", async () => {
  for (const mode of ["archived", "auth", "rich"] as const) {
    const { session, writes } = harness();
    const item = fixtureItem();
    if (mode === "archived") item.archived = true;
    const result = await writeTask({
      session:
        mode === "auth"
          ? { ...session, canFetch: false, fetchAs: undefined }
          : session,
      list: fixtureList(),
      item:
        mode === "rich"
          ? {
              ...item,
              richText: [
                {
                  type: "rich_text",
                  elements: [{ type: "rich_text_list", elements: [] }],
                },
              ],
            }
          : item,
      kind: "update",
      values: { title: "New" },
    });
    assert.equal(result.kind, "failed");
    assert.equal(writes.length, 0);
  }
});
test("G-002未確認型とG-003未確認クリアを送らない", async () => {
  const { session, writes } = harness();
  let result = await writeTask({
    session,
    list: fixtureList(),
    kind: "create",
    values: { title: "New", completed: false },
  });
  assert.equal(result.kind, "failed");
  result = await writeTask({
    session,
    list: fixtureList(),
    item: fixtureItem(),
    kind: "update",
    verifiedTypes: VERIFIED,
    values: { title: "Task", assigneeIds: [] },
  });
  assert.equal(result.kind, "failed");
  result = await writeTask({
    session,
    list: fixtureList(),
    item: fixtureItem(),
    kind: "update",
    verifiedTypes: VERIFIED,
    values: { title: "Task", dueDate: null },
  });
  assert.equal(result.kind, "failed");
  assert.equal(writes.length, 0);
});
test("既存の元リンクを壊すrich_textは拒否", () => {
  const rich = textBlocks(
    "Task",
    "https://test.slack.com/archives/CTEST/p1790967145033309",
  );
  assert.equal(editableTitle(rich), "Task");
  assert.match(JSON.stringify(replaceTitle(rich, "Updated")), /元メッセージ/);
  assert.equal(
    editableTitle([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "bold", style: { bold: true } }],
          },
        ],
      },
    ]),
    undefined,
  );
});
test("メッセージ列が一意なら出典そこへ、なければprimary末尾リンク", async () => {
  const source = "https://test.slack.com/archives/CTEST/p1790967145033309";
  for (const messageColumn of [false, true]) {
    const list = fixtureList();
    if (messageColumn)
      list.columns.push({ id: "ColMessage", type: "message", primary: false });
    const rawList = {
      ...RAW_LIST,
      list_metadata: {
        schema: list.columns.map((column) => ({
          id: column.id,
          type: column.type,
          is_primary_column: column.primary,
        })),
      },
    };
    const { session, writes } = harness({ list: rawList });
    const result = await writeTask({
      session,
      list,
      kind: "create",
      source,
      values: { title: "New" },
    });
    assert.equal(result.kind, "succeeded");
    const fields = (
      writes[0].params as { initial_fields: Record<string, unknown>[] }
    ).initial_fields;
    if (messageColumn)
      assert.deepEqual(fields[1], {
        column_id: "ColMessage",
        message: [source],
      });
    else assert.match(JSON.stringify(fields[0].rich_text), /元メッセージ/);
  }
});
test("createの読めない成功応答は結果未確認、再送0回", async () => {
  const { session, writes } = harness({
    response: { ok: true, item: { id: "RecNEW", list_id: "FOTHER" } },
  });
  const result = await writeTask({
    session,
    list: fixtureList(),
    kind: "create",
    values: { title: "New" },
  });
  assert.equal(result.kind, "unconfirmed");
  assert.equal(writes.length, 1);
});
for (const [error, kind] of [
  [new SlackApiError("api", "missing", undefined, "missing_scope"), "failed"],
  [
    new SlackApiError("api", "internal", undefined, "internal_error"),
    "unconfirmed",
  ],
  [new SlackApiError("timeout", "timeout"), "unconfirmed"],
] as const) {
  test(`書込結果分類: ${error.kind} ${kind}`, async () => {
    const { session, writes } = harness({ error });
    const result = await writeTask({
      session,
      list: fixtureList(),
      kind: "create",
      values: { title: "New" },
    });
    assert.equal(result.kind, kind);
    assert.equal(writes.length, 1);
  });
}
test("遅延preflight中の認証・対象変更後はmutation0回", async () => {
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = true;
  let writes = 0;
  const api: ApiCall = async (method) => {
    if (method === "slackLists.items.list") {
      await pause;
      return { ok: true, list: RAW_LIST, items: [] };
    }
    writes++;
    return { ok: true, item: { id: "RecNEW", list_id: "FTEST" } };
  };
  const pending = writeTask({
    session: fixtureSession(api),
    list: fixtureList(),
    kind: "create",
    values: { title: "New" },
    isCurrent: () => current,
  });
  current = false;
  release();
  assert.equal((await pending).kind, "failed");
  assert.equal(writes, 0);
});

test("単純な外部HTTPリンクもタイトル編集でそのまま保持する", () => {
  const rich = textBlocks("Task", "https://example.com/reference");
  assert.equal(editableTitle(rich), "Task");
  assert.match(
    JSON.stringify(replaceTitle(rich, "Updated")),
    /https:\/\/example.com\/reference/,
  );
});
