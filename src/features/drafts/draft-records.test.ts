import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addRecord,
  createDraftStore,
  DRAFT_RECORD_TTL_MS,
  DRAFT_RECORDS_FILE,
  parseRecords,
  recordDestination,
  recordLink,
  recordsFor,
  recordTitle,
  removeRecord,
  withMentionNames,
  type DraftRecord,
} from "./draft-records.ts";

const NOW = Date.parse("2026-10-08T01:00:00.000Z");
const ME = { teamId: "T1", userId: "U1" };
const DAY = 24 * 60 * 60_000;

const record = (overrides: Partial<DraftRecord> = {}): DraftRecord => ({
  draftId: "Dr1",
  teamId: "T1",
  userId: "U1",
  target: { kind: "conversation", id: "C1" },
  destination: "#example_remind",
  markdown: "本文",
  createdAt: new Date(NOW - DAY).toISOString(),
  ...overrides,
});

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "draft-records-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- 純粋な部分 --------------------------------------------------------------------

test("parseRecords: 壊れた控えを捨て、配列でなければ undefined", () => {
  const good = record();
  assert.deepEqual(
    parseRecords([
      good,
      { ...good, draftId: "" },
      { ...good, target: { kind: "group", id: "C1" } },
      { ...good, createdAt: "きのう" },
      { ...good, threadTs: 1 },
      "文字",
      null,
    ]),
    [good],
  );
  assert.equal(parseRecords({ records: [] }), undefined);
  assert.equal(parseRecords(undefined), undefined);
});

test("recordsFor: 別のワークスペース・別の人・30日を過ぎた控えを除き、新しい順に並べる", () => {
  const older = record({
    draftId: "Dr-old",
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
  });
  const newer = record({
    draftId: "Dr-new",
    createdAt: new Date(NOW - 1000).toISOString(),
  });
  const otherTeam = record({ draftId: "Dr-team", teamId: "T2" });
  const otherUser = record({ draftId: "Dr-user", userId: "U2" });
  const expired = record({
    draftId: "Dr-expired",
    createdAt: new Date(NOW - DRAFT_RECORD_TTL_MS - 1).toISOString(),
  });
  const edge = record({
    draftId: "Dr-edge",
    createdAt: new Date(NOW - DRAFT_RECORD_TTL_MS).toISOString(),
  });

  assert.deepEqual(
    recordsFor(
      [older, otherTeam, expired, newer, otherUser, edge],
      ME,
      NOW,
    ).map((r) => r.draftId),
    ["Dr-new", "Dr-old", "Dr-edge"],
  );
});

test("addRecord と removeRecord: 同じ draft_id は置き換え、消すのは自分の控えだけ", () => {
  const first = record({ markdown: "前" });
  const replaced = addRecord([first], record({ markdown: "後" }));
  assert.deepEqual(
    replaced.map((r) => r.markdown),
    ["後"],
  );

  const others = record({ userId: "U2" });
  assert.deepEqual(removeRecord([first, others], "Dr1", ME), [others]);
});

test("recordTitle: 空行とメンションだけの行を飛ばした最初の行", () => {
  assert.equal(
    recordTitle({ markdown: "<@U1> <@U2>\n\n**確認** お願いします\n2行目" }),
    "**確認** お願いします",
  );
  assert.equal(recordTitle({ markdown: "<@U1>\n\n" }), "（本文なし）");
});

test("withMentionNames: 分かる人は @名前、分からない人は @ID", () => {
  assert.equal(
    withMentionNames("<@U1> <@U2>\n\n本文", new Map([["U1", "田中"]])),
    "@田中 @U2\n\n本文",
  );
});

test("recordDestination と recordLink: 返信はスレッドの親、それ以外は宛先を開く", () => {
  const reply = record({ threadTs: "1791327335.337259" });
  assert.equal(recordDestination(reply), "#example_remind のスレッド");
  assert.equal(
    recordLink(reply),
    "slack://channel?team=T1&id=C1&message=1791327335.337259",
  );

  assert.equal(recordDestination(record()), "#example_remind");
  assert.equal(recordLink(record()), "slack://channel?team=T1&id=C1");
  assert.equal(
    recordLink(
      record({ target: { kind: "person", id: "U9" }, destination: "@someone" }),
    ),
    "slack://user?team=T1&id=U9",
  );
});

// ---- ファイル ----------------------------------------------------------------------

test("createDraftStore: 足した控えが読み込みに出て、消した控えは出ない", () =>
  withDir(async (dir) => {
    const store = createDraftStore(dir, { now: () => NOW });
    assert.deepEqual(store.load(ME), []);

    store.add(record({ draftId: "Dr1" }));
    store.add(
      record({ draftId: "Dr2", createdAt: new Date(NOW - 10).toISOString() }),
    );
    assert.deepEqual(
      store.load(ME).map((r) => r.draftId),
      ["Dr2", "Dr1"],
    );

    store.remove("Dr1", ME);
    assert.deepEqual(
      store.load(ME).map((r) => r.draftId),
      ["Dr2"],
    );
    // 2つのコマンドから使っても同じ中身が見える（別のインスタンスで読み直す）
    assert.deepEqual(
      createDraftStore(dir, { now: () => NOW })
        .load(ME)
        .map((r) => r.draftId),
      ["Dr2"],
    );
    // 一時ファイルは残らない
    assert.deepEqual(await readdir(dir), [DRAFT_RECORDS_FILE]);
  }));

test("createDraftStore: 読み込みで期限切れと壊れた控えを書き戻して消し、別の人の控えは残す", () =>
  withDir(async (dir) => {
    const mine = record({ draftId: "Dr-mine" });
    const others = record({ draftId: "Dr-others", teamId: "T2", userId: "U2" });
    const expired = record({
      draftId: "Dr-expired",
      createdAt: new Date(NOW - DRAFT_RECORD_TTL_MS - 1).toISOString(),
    });
    await writeFile(
      join(dir, DRAFT_RECORDS_FILE),
      JSON.stringify([mine, { broken: true }, others, expired]),
    );

    const store = createDraftStore(dir, { now: () => NOW });
    assert.deepEqual(
      store.load(ME).map((r) => r.draftId),
      ["Dr-mine"],
    );

    const saved = JSON.parse(
      await readFile(join(dir, DRAFT_RECORDS_FILE), "utf8"),
    );
    // 読めない控えがあったので、書き戻す前の中身を別名に写してある
    assert.equal(
      JSON.parse(
        await readFile(
          join(dir, `${DRAFT_RECORDS_FILE}.broken-${NOW}`),
          "utf8",
        ),
      ).length,
      4,
    );
    assert.deepEqual(
      saved.map((r: DraftRecord) => r.draftId),
      ["Dr-mine", "Dr-others"],
    );
  }));

test("createDraftStore: JSON として読めないファイルは別名に退避して、空から始める", () =>
  withDir(async (dir) => {
    await writeFile(join(dir, DRAFT_RECORDS_FILE), "{ 壊れている");
    const warnings: string[] = [];
    const store = createDraftStore(dir, {
      now: () => NOW,
      warn: (m) => warnings.push(m),
    });

    assert.deepEqual(store.load(ME), []);
    assert.ok(existsSync(join(dir, `${DRAFT_RECORDS_FILE}.broken-${NOW}`)));
    assert.equal(warnings.length, 1);

    store.add(record());
    assert.deepEqual(
      store.load(ME).map((r) => r.draftId),
      ["Dr1"],
    );
    // 退避したファイルは上書きしない
    assert.equal(
      await readFile(join(dir, `${DRAFT_RECORDS_FILE}.broken-${NOW}`), "utf8"),
      "{ 壊れている",
    );
  }));
