import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listedPeople,
  mentionCandidates,
  mentionLabel,
  toPeople,
  type RawUser,
} from "./people.ts";

const raw: RawUser[] = [
  {
    id: "U1",
    name: "sato_y",
    real_name: "佐藤 由",
    profile: { display_name: "佐藤", real_name: "佐藤 由", title: "開発" },
  },
  { id: "U2", name: "retired_x", real_name: "退職 太郎", deleted: true },
  {
    id: "U3",
    name: "shinonomelobot",
    real_name: "ExampleBot",
    is_bot: true,
    profile: { display_name: "", real_name: "ExampleBot" },
  },
  { id: "U4", name: "old_bot", deleted: true, is_bot: true },
  // 表示名・本名が無い人は、ハンドルで代える
  { id: "U5", name: "jones_f" },
];

test("削除済みは除き、ボットには isBot を付けて残す", () => {
  const people = toPeople(raw);
  assert.deepEqual(
    people.map((p) => [p.id, p.isBot]),
    [
      ["U1", false],
      ["U3", true],
      ["U5", false],
    ],
  );
});

test("is_bot のユーザーは一覧の人の行から外れ、メンションの候補には入る", () => {
  const people = toPeople(raw);
  assert.deepEqual(
    listedPeople(people).map((p) => p.id),
    ["U1", "U5"],
  );
  const candidates = mentionCandidates(people);
  assert.deepEqual(
    candidates.map((p) => p.id),
    ["U1", "U3", "U5"],
  );
  // ExampleBot と打てば候補に出る（表示名が空なので、本名が表示名になる）
  const bot = candidates.find((p) => p.id === "U3");
  assert.equal(bot?.displayName, "ExampleBot");
  assert.equal(bot?.handle, "shinonomelobot");
});

test("表示名・本名・肩書きは、プロフィールを優先して読み、無ければ代える", () => {
  const [first, , fifth] = toPeople(raw);
  assert.deepEqual(first, {
    id: "U1",
    handle: "sato_y",
    displayName: "佐藤",
    realName: "佐藤 由",
    title: "開発",
    isBot: false,
  });
  assert.deepEqual(fifth, {
    id: "U5",
    handle: "jones_f",
    displayName: "jones_f",
    realName: "jones_f",
    title: "",
    isBot: false,
  });
});

test("メンションの候補を並べ替えても、元の一覧は変わらない", () => {
  const people = toPeople(raw);
  const candidates = mentionCandidates(people);
  candidates.reverse();
  assert.deepEqual(
    people.map((p) => p.id),
    ["U1", "U3", "U5"],
  );
});

test("メンション欄の名前は、表示名・本名・ハンドルのどれで打っても当たるよう3つを含む", () => {
  const people = toPeople(raw);
  const labels = new Map(people.map((p) => [p.id, mentionLabel(p)]));
  // 本名が表示名と違う人
  assert.equal(labels.get("U1"), "佐藤（佐藤 由 @sato_y）");
  // ボット。ExampleBot と打てば候補に出る
  assert.equal(labels.get("U3"), "ExampleBot（@shinonomelobot）");
  assert.ok(labels.get("U3")?.includes("ExampleBot"));
  // 本名が表示名と同じ人（ここでは、どちらもハンドルで代えた人）は、本名を重ねず、ハンドルだけを足す
  assert.equal(labels.get("U5"), "jones_f（@jones_f）");
});
