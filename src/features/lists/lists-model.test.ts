import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_ITEMS,
  filterItems,
  itemDetails,
  readItem,
  readList,
  validDate,
} from "./lists-model.ts";
import { taskCapabilities } from "./task-capabilities.ts";
import {
  fixtureItem,
  fixtureList,
  RAW_LIST,
  rawItem,
  VERIFIED,
} from "./test-fixtures.ts";

test("スキーマは実際の列IDとprimary印で識別し、名前を推測しない", () => {
  const list = fixtureList();
  assert.equal(taskCapabilities(list, VERIFIED).primary?.id, "ColTitle");
  assert.equal(taskCapabilities(list).assignee, undefined);
  assert.equal(taskCapabilities(list).completed, undefined);
  assert.equal(taskCapabilities(list).due, undefined);
});
test("曖昧なprimaryとtodo系列の重複は操作候補にしない", () => {
  const list = fixtureList();
  list.columns.push(
    { id: "ColOtherTitle", primary: true, type: "text" },
    { id: "ColOtherDone", type: "todo_completed", primary: false },
  );
  const capabilities = taskCapabilities(list, [...VERIFIED, "todo_completed"]);
  assert.equal(capabilities.primary, undefined);
  assert.equal(capabilities.completed, undefined);
  assert.equal(capabilities.assignee?.id, "ColAssignee");
});
test("編集権限が不明またはfalseなら閲覧のみ", () => {
  assert.equal(
    readList({ ...RAW_LIST, editable: undefined }, "TTEST").editable,
    false,
  );
  assert.equal(
    readList({ ...RAW_LIST, editable: false }, "TTEST").editable,
    false,
  );
});
test("異なるリストIDと重複列IDと不明schemaを拒否", () => {
  assert.throws(() => readList(RAW_LIST, "TTEST", "FOTHER"));
  assert.throws(() => readList({ ...RAW_LIST, list_metadata: {} }, "TTEST"));
  assert.throws(() =>
    readList(
      {
        ...RAW_LIST,
        list_metadata: {
          schema: [
            RAW_LIST.list_metadata.schema[0],
            RAW_LIST.list_metadata.schema[0],
          ],
        },
      },
      "TTEST",
    ),
  );
});
test("担当・期限・完了は列IDの型付き値を読む", () => {
  const item = fixtureItem();
  assert.deepEqual(item.assigneeIds, ["UTEST"]);
  assert.equal(item.completed, false);
  assert.equal(item.dueDate, "2026-10-10");
  assert.match(item.title, /Task/);
});
test("欠損セルは未担当・期限なし・未完了、壊れた型はunknown", () => {
  const list = fixtureList(),
    caps = taskCapabilities(list, VERIFIED);
  const blank = readItem(
    rawItem("RecBLANK", { fields: [] }),
    list,
    false,
    caps,
  );
  assert.deepEqual(blank.assigneeIds, []);
  assert.equal(blank.completed, false);
  assert.equal(blank.dueDate, null);
  const bad = readItem(
    rawItem("RecBAD", {
      fields: [
        { column_id: "ColAssignee", user: "UTEST" },
        { column_id: "ColDone", checkbox: "false" },
        { column_id: "ColDue", date: ["2026-02-30"] },
      ],
    }),
    list,
    false,
    caps,
  );
  assert.equal(bad.assigneeIds, undefined);
  assert.equal(bad.completed, undefined);
  assert.equal(bad.dueDate, undefined);
});
test("存在する壊れたvalueを空セル扱いしない", () => {
  const list = fixtureList(),
    caps = taskCapabilities(list, VERIFIED);
  const bad = readItem(
    rawItem("RecBAD", {
      fields: [
        { column_id: "ColAssignee", value: "UTEST" },
        { column_id: "ColDone", value: "nope" },
        { column_id: "ColDue", value: "tomorrow" },
      ],
    }),
    list,
    false,
    caps,
  );
  assert.equal(bad.assigneeIds, undefined);
  assert.equal(bad.completed, undefined);
  assert.equal(bad.dueDate, undefined);
});
test("checkbox単値と単要素配列、未知型の除外", () => {
  const list = fixtureList(),
    caps = taskCapabilities(list, VERIFIED);
  assert.equal(
    readItem(
      rawItem("RecA", { fields: [{ column_id: "ColDone", checkbox: [true] }] }),
      list,
      false,
      caps,
    ).completed,
    true,
  );
  assert.equal(
    readItem(
      rawItem("RecA", {
        fields: [{ column_id: "ColDone", checkbox: [true, false] }],
      }),
      list,
      false,
      caps,
    ).completed,
    undefined,
  );
  assert.equal(readItem(rawItem(), list).completed, undefined);
});
test("My Incompleteは本人配列一致かつ既知falseだけ", () => {
  const item = fixtureItem();
  const candidates = [
    item,
    { ...item, id: "RecComplete", completed: true },
    { ...item, id: "RecOther", assigneeIds: ["UOTHER"] },
    { ...item, id: "RecUnknown", completed: undefined },
    { ...item, id: "RecBad", assigneeIds: undefined },
  ];
  assert.deepEqual(
    filterItems(candidates, { assignee: "UTEST", status: "incomplete" }).map(
      (item) => item.id,
    ),
    [item.id],
  );
  assert.equal(filterItems(candidates, ALL_ITEMS).length, 5);
});
test("archivedと子項目を表示し、異なるリストの項目を拒否", () => {
  const list = fixtureList();
  const item = readItem(
    rawItem("RecCHILD", { parent_record_id: "RecPARENT" }),
    list,
    true,
  );
  assert.equal(item.archived, true);
  assert.equal(item.parentRecordId, "RecPARENT");
  assert.match(itemDetails(item), /子項目/);
  assert.match(itemDetails(item), /閲覧のみ/);
  assert.throws(() =>
    readItem(rawItem("RecOTHER", { list_id: "FOTHER" }), list),
  );
});
test("日付は日付のまま保持し不正暦日を拒否", () => {
  assert.equal(validDate("2028-02-29"), true);
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2026-10-10T00:00:00Z"), false);
});
