import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheNamespace, scopeKey, type Identity } from "./identity.ts";
import {
  LEGACY_NAMESPACE,
  MIGRATED_KEYS,
  MIGRATED_TO_KEY,
  planMarksMigration,
  type MigrationWrite,
  type StoredMarks,
} from "./marks-migration.ts";

// このテストは Cache を使わない。古い名前空間と新しい名前空間は、ただの Map にする。
// 実物（read-state.ts の migrateLegacyMarks）は、判断が返した書く値を、順に書くだけ

const ME: Identity = {
  userId: "U0000000017",
  user: "taro_y",
  teamId: "T0000000012",
  team: "Example Inc",
  url: "https://example.slack.com/",
};
const OTHER: Identity = { ...ME, userId: "U0000000014", user: "hanako_s" };

// 更新の前の版が書いた形（メッセージの key → 付けた時刻、会話 ID → ts）
const OLD_MARKS = JSON.stringify({
  "C0000000008:1759000000.000100": 1759000000000,
});
const OLD_OPENED = JSON.stringify({ C0000000008: "1759000000.000100" });

type Stores = {
  legacy: Map<string, string>;
  current: Map<string, string>;
};

// read-state.ts の migrateLegacyMarks と同じ手順：2つの名前空間から読んで判断し、返された値を順に書く
function run(stores: Stores, to: Identity): MigrationWrite[] {
  const stored = (map: Map<string, string>): StoredMarks => ({
    marks: map.get("marks"),
    opened: map.get("opened"),
  });
  const writes = planMarksMigration({
    legacy: stored(stores.legacy),
    migratedTo: stores.legacy.get(MIGRATED_TO_KEY),
    current: stored(stores.current),
    destination: scopeKey(to),
  });
  for (const { namespace, key, value } of writes) {
    (namespace === "legacy" ? stores.legacy : stores.current).set(key, value);
  }
  return writes;
}

const stores = (init: {
  legacy?: Record<string, string>;
  current?: Record<string, string>;
}): Stores => ({
  legacy: new Map(Object.entries(init.legacy ?? {})),
  current: new Map(Object.entries(init.current ?? {})),
});

test("新しい名前空間に marks も opened も無ければ、古い名前空間の2つを、値のまま新しい名前空間へ移す。移した先を、古い側に書く", () => {
  const s = stores({ legacy: { marks: OLD_MARKS, opened: OLD_OPENED } });
  assert.deepEqual(run(s, ME), [
    { namespace: "current", key: "marks", value: OLD_MARKS },
    { namespace: "current", key: "opened", value: OLD_OPENED },
    {
      namespace: "legacy",
      key: MIGRATED_TO_KEY,
      value: "T0000000012-U0000000017",
    },
  ]);
  assert.equal(s.current.get("marks"), OLD_MARKS);
  assert.equal(s.current.get("opened"), OLD_OPENED);
  assert.equal(s.legacy.get(MIGRATED_TO_KEY), "T0000000012-U0000000017");
});

test("古い名前空間に片方しか無ければ、ある方だけ移す（無い方を作らない）。移した先は書く", () => {
  const onlyMarks = stores({ legacy: { marks: OLD_MARKS } });
  assert.deepEqual(
    run(onlyMarks, ME).map(({ namespace, key }) => `${namespace}:${key}`),
    ["current:marks", `legacy:${MIGRATED_TO_KEY}`],
  );
  assert.equal(onlyMarks.current.has("opened"), false);

  const onlyOpened = stores({ legacy: { opened: OLD_OPENED } });
  assert.deepEqual(
    run(onlyOpened, ME).map(({ namespace, key }) => `${namespace}:${key}`),
    ["current:opened", `legacy:${MIGRATED_TO_KEY}`],
  );
  assert.equal(onlyOpened.current.has("marks"), false);
});

test("新しい名前空間に marks か opened のどちらかでもあれば、移さない（その人の印を上書きしない・印も書かない）", () => {
  const inputs: Record<string, string>[] = [
    { marks: "{}" },
    { opened: "{}" },
    { marks: OLD_MARKS, opened: OLD_OPENED },
    // 空の記録（印をすべて外したあとの "{}"）でも、あるものとして扱う
    { marks: "{}", opened: "{}" },
  ];
  for (const current of inputs) {
    const s = stores({
      legacy: { marks: OLD_MARKS, opened: OLD_OPENED },
      current,
    });
    assert.deepEqual(run(s, ME), [], JSON.stringify(current));
    assert.equal(s.legacy.has(MIGRATED_TO_KEY), false);
    assert.deepEqual(Object.fromEntries(s.current), current);
  }
});

test("古い名前空間に「移した」印があれば、新しい名前空間が空でも移さない（あとで別のプロファイルの人が開いても、その人には移らない）", () => {
  const s = stores({
    legacy: {
      marks: OLD_MARKS,
      opened: OLD_OPENED,
      [MIGRATED_TO_KEY]: scopeKey(ME),
    },
  });
  // 移した相手とは違う人（別のワークスペース・別のユーザー ID のどちらでも）
  assert.deepEqual(run(s, OTHER), []);
  assert.deepEqual(run(s, { ...ME, teamId: "T0000000011" }), []);
  assert.equal(s.current.size, 0);
});

test("古い名前空間に marks も opened も無ければ、何もしない（「移した」印も書かない）。空の文字列も、無いのと同じ", () => {
  const noMarks: Record<string, string>[] = [
    {},
    { marks: "", opened: "" },
    { other: "x" },
  ];
  for (const legacy of noMarks) {
    const s = stores({ legacy });
    assert.deepEqual(run(s, ME), [], JSON.stringify(legacy));
    assert.equal(s.current.size, 0);
    assert.equal(s.legacy.has(MIGRATED_TO_KEY), false);
  }
  // 新しい側が空の文字列だけなら、無いのと同じなので移す
  const s = stores({
    legacy: { marks: OLD_MARKS },
    current: { marks: "", opened: "" },
  });
  assert.equal(run(s, ME).length, 2);
});

test("2回目は移さない。同じ人が開き直しても、別の人が開いても、何も書かない", () => {
  const s = stores({ legacy: { marks: OLD_MARKS, opened: OLD_OPENED } });
  assert.equal(run(s, ME).length, 3);
  const afterFirst = {
    legacy: Object.fromEntries(s.legacy),
    current: Object.fromEntries(s.current),
  };
  // 同じ人：新しい側に印があり、移した印もある
  assert.deepEqual(run(s, ME), []);
  // 別の人：新しい側は空だが、移した印がある
  assert.deepEqual(run(s, OTHER), []);
  assert.deepEqual(Object.fromEntries(s.legacy), afterFirst.legacy);
  assert.deepEqual(Object.fromEntries(s.current), afterFirst.current);
});

test("新しい側の印を使い切って空にしても（その人が印を外し続けた場合）、2回目は移さない。移した印が止める", () => {
  const s = stores({ legacy: { marks: OLD_MARKS, opened: OLD_OPENED } });
  run(s, ME);
  s.current.delete("marks");
  s.current.delete("opened");
  assert.deepEqual(run(s, ME), []);
});

test("古い名前空間の値は、消さない・書き換えない。足すのは「移した」印だけで、移すのは marks と opened だけ", () => {
  const s = stores({
    legacy: {
      marks: OLD_MARKS,
      opened: OLD_OPENED,
      // 既読位置・整理の結果など。移さないし、触らない
      lastRead: '{"C0000000008":{"lastRead":null,"at":1}}',
      triage: '{"at":1,"hits":[]}',
    },
  });
  const before = Object.fromEntries(s.legacy);
  const writes = run(s, ME);
  for (const write of writes) {
    if (write.namespace === "legacy") assert.equal(write.key, MIGRATED_TO_KEY);
    else assert.ok((MIGRATED_KEYS as readonly string[]).includes(write.key));
  }
  assert.deepEqual(Object.fromEntries(s.legacy), {
    ...before,
    [MIGRATED_TO_KEY]: "T0000000012-U0000000017",
  });
  assert.deepEqual(Object.keys(Object.fromEntries(s.current)).sort(), [
    "marks",
    "opened",
  ]);
});

test("書く順は、値を先に、「移した」印を最後にする（途中で止まっても、その人の印を失わない）", () => {
  const writes = planMarksMigration({
    legacy: { marks: OLD_MARKS, opened: OLD_OPENED },
    migratedTo: undefined,
    current: {},
    destination: scopeKey(ME),
  });
  assert.equal(writes.at(-1)?.namespace, "legacy");
  assert.deepEqual(
    writes.slice(0, -1).map((write) => write.namespace),
    ["current", "current"],
  );
});

test("古い名前空間は、自分の情報が決まる前の messages。新しい名前空間（messages-<teamId>-<userId>）とは別", () => {
  assert.equal(LEGACY_NAMESPACE, "messages");
  assert.notEqual(cacheNamespace("messages", ME), LEGACY_NAMESPACE);
  assert.equal(cacheNamespace("messages", ME), `messages-${scopeKey(ME)}`);
});
