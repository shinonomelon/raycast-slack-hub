import test from "node:test";
import assert from "node:assert/strict";
import type { ApiCall } from "../../slack/slack-api.ts";
import {
  DiscoveryController,
  ListsController,
  MAX_LIST_BYTES,
} from "./lists-controller.ts";
import { fetchItemInfo, fetchItems } from "./lists-api.ts";
import { RAW_LIST, rawItem } from "./test-fixtures.ts";
import { textBlocks } from "./task-write.ts";
function page(items: unknown[], cursor = "") {
  return {
    ok: true,
    list: RAW_LIST,
    items,
    response_metadata: { next_cursor: cursor },
  };
}
test("項目cursorは手動1ページ追加、重複IDは1件にし取得途中を保持", async () => {
  const calls: unknown[] = [];
  const api: ApiCall = async (_method, params) => {
    calls.push(params);
    return calls.length === 1
      ? page([rawItem("RecA")], "next")
      : page([rawItem("RecA"), rawItem("RecB")]);
  };
  const controller = new ListsController(
    api,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await controller.load();
  assert.equal(calls.length, 1);
  assert.equal(controller.state.cursor, "next");
  await controller.load();
  assert.equal(calls.length, 2);
  assert.equal(controller.state.items.length, 2);
  assert.equal(controller.state.cursor, "");
  await controller.load();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    list_id: "FTEST",
    limit: 100,
    include_list: true,
    archived: false,
    cursor: "next",
  });
});
test("通常とアーカイブは別controllerで別cursor・項目", async () => {
  const api: ApiCall = async (_method, params) =>
    page([rawItem(params?.archived ? "RecARCH" : "RecACTIVE")]);
  const active = new ListsController(api, "TTEST", "FTEST", false, () => {});
  const archived = new ListsController(api, "TTEST", "FTEST", true, () => {});
  await active.load();
  await archived.load();
  assert.equal(active.state.items[0].id, "RecACTIVE");
  assert.equal(active.state.items[0].archived, false);
  assert.equal(archived.state.items[0].id, "RecARCH");
  assert.equal(archived.state.items[0].archived, true);
});
test("2MiB上限では保持を抑え取得途中を表示し追加通信しない", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return page(
      [
        rawItem("RecSMALL"),
        rawItem("RecHUGE", {
          fields: [
            {
              column_id: "ColTitle",
              rich_text: textBlocks("x".repeat(MAX_LIST_BYTES)),
            },
          ],
        }),
      ],
      "next",
    );
  };
  const controller = new ListsController(
    api,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await controller.load();
  assert.equal(controller.state.capped, true);
  assert.equal(controller.state.items.length, 1);
  await controller.load();
  assert.equal(calls, 1);
});
test("10,000項目上限とcursor循環で無限巡回しない", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return page(
      Array.from({ length: 10000 }, (_, index) =>
        rawItem(`Rec${index}`, { fields: [] }),
      ),
      "next",
    );
  };
  const controller = new ListsController(
    api,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await controller.load();
  assert.equal(controller.state.capped, true);
  await controller.load();
  assert.equal(calls, 1);
  let cycle = 0;
  const cycleApi: ApiCall = async () => page([], ["a", "b", "a"][cycle++]);
  const cycling = new ListsController(
    cycleApi,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await cycling.load();
  await cycling.load();
  await cycling.load();
  assert.match(cycling.state.error ?? "", /同じページ/);
  assert.equal(cycling.state.cursor, "b");
});
test("別対象/api controllerはdispose済み遅延結果を反映しない", async () => {
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updates = 0;
  const oldApi: ApiCall = async () => {
    await pause;
    return page([rawItem("RecOLD")]);
  };
  const old = new ListsController(oldApi, "TTEST", "FTEST", false, () => {
    updates++;
  });
  const pending = old.load();
  old.dispose();
  const before = updates;
  const fresh = new ListsController(
    async () => page([rawItem("RecNEW")]),
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await fresh.load();
  release();
  await pending;
  assert.equal(updates, before);
  assert.equal(old.state.items.length, 0);
  assert.equal(fresh.state.items[0].id, "RecNEW");
});
test("refreshの新世代に旧応答を混ぜない", async () => {
  let release!: () => void;
  let calls = 0;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api: ApiCall = async () => {
    const number = ++calls;
    if (number === 1) await pause;
    return page([rawItem(number === 1 ? "RecOLD" : "RecNEW")]);
  };
  const controller = new ListsController(
    api,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  const old = controller.load();
  await controller.load(true);
  release();
  await old;
  assert.equal(controller.state.items[0].id, "RecNEW");
});
test("取得失敗は既取得結果を残し全件ゼロに変えない", async () => {
  let count = 0;
  const api: ApiCall = async () => {
    if (++count === 1) return page([rawItem()], "next");
    throw new Error("missing_scope");
  };
  const controller = new ListsController(
    api,
    "TTEST",
    "FTEST",
    false,
    () => {},
  );
  await controller.load();
  await controller.load();
  assert.equal(controller.state.items.length, 1);
  assert.equal(controller.state.cursor, "next");
  assert.match(controller.state.error ?? "", /missing_scope/);
});
test("発見検索はID重複を除き追加ページを手動読込", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return {
      ok: true,
      files: {
        matches: [
          { id: "FA", filetype: "list", title: "List" },
          ...(calls > 1
            ? [{ id: "FB", filetype: "list", title: "Second" }]
            : []),
        ],
        paging: { total: 150, pages: 2 },
      },
    };
  };
  const controller = new DiscoveryController(api, "TTEST", () => {});
  await controller.load();
  assert.equal(calls, 1);
  assert.equal(controller.state.hasMore, true);
  await controller.load();
  assert.equal(controller.state.lists.length, 2);
  assert.equal(controller.state.hasMore, false);
  await controller.load();
  assert.equal(calls, 2);
});
test("fetchItemsはlimit・list IDの入力を通信前に拒否", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return page([]);
  };
  await assert.rejects(fetchItems(api, "TTEST", "FTEST", { limit: 101 }));
  await assert.rejects(fetchItems(api, "TTEST", "not-list"));
  assert.equal(calls, 0);
});
test("items.infoの返却record/list IDを照合", async () => {
  await assert.rejects(
    fetchItemInfo(
      async () => ({ ok: true, list: RAW_LIST, record: rawItem("RecOTHER") }),
      "TTEST",
      "FTEST",
      "RecTEST",
    ),
  );
});
