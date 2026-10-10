import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { emptyLibrary, libraryKey, type ChannelLibrary } from "./model.ts";

// 実hookの世代境界を動かし、古い保存結果が別アカウントへ表示されないことを確かめる。
function hookHarness() {
  const slots: unknown[] = [];
  let index = 0;
  const effects: (() => void)[] = [];
  let initialize: (value: {
    library: ChannelLibrary;
    ready: boolean;
  }) => void = () => {};
  let saved: (value: ChannelLibrary) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const react = {
    useState: (initial: () => unknown) => {
      const id = index++;
      if (!(id in slots)) slots[id] = initial();
      return [
        slots[id],
        (next: unknown) => {
          slots[id] = typeof next === "function" ? next(slots[id]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const id = index++;
      return slots[id] ?? (slots[id] = { current: initial });
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => () => void, deps: unknown[]) => {
      const id = index++;
      const old = slots[id] as
        { deps: unknown[]; cleanup?: () => void } | undefined;
      // reloadはmockのuseCallbackが毎回作るため、実際の安定した依存と同様に扱う。
      if (!old || deps.slice(0, -1).some((value, i) => value !== old.deps[i])) {
        old?.cleanup?.();
        slots[id] = { deps };
        effects.push(() => {
          (slots[id] as { cleanup?: () => void }).cleanup = fn();
        });
      }
    },
  };
  const store = {
    initialize: () =>
      new Promise((resolve) => {
        initialize = resolve;
      }),
    mutate: () =>
      new Promise((resolve, reject) => {
        saved = resolve;
        fail = reject;
      }),
  };
  const exports: Record<
    string,
    (props: unknown) => {
      library: ChannelLibrary;
      ready: boolean;
      error: string;
      mutate: (mutation: unknown) => Promise<ChannelLibrary | false>;
    }
  > = {};
  const deps: Record<string, unknown> = {
    "@raycast/api": { environment: { supportPath: "fixture" } },
    react,
    "./model.ts": { emptyLibrary, libraryKey },
    "./store.ts": { createChannelLibraryStore: () => store },
  };
  const source = ts.transpileModule(
    readFileSync("src/features/channel-library/use-channel-library.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  runInNewContext(source, {
    exports,
    require: (id: string) => deps[id],
    Error,
  });
  return {
    render: (userId = "U1") => {
      index = 0;
      const result = exports.useChannelLibrary({
        identity: { teamId: "T1", userId },
        conversations: [],
        directoryComplete: false,
        legacyFavorites: [],
      });
      while (effects.length) effects.shift()!();
      return result;
    },
    initialize: (library: ChannelLibrary) =>
      initialize({ library, ready: true }),
    saved: (library: ChannelLibrary) => saved(library),
    fail: (message: string) => fail(new Error(message)),
  };
}
test("account切替直後に旧データを表示せず、進行中の旧保存結果も反映しない", async () => {
  const ui = hookHarness();
  ui.render();
  const a = {
    ...emptyLibrary({ teamId: "T1", userId: "U1" }),
    favoriteChannelIds: ["C1"],
  };
  ui.initialize(a);
  await new Promise(setImmediate);
  const state = ui.render();
  assert.deepEqual(state.library.favoriteChannelIds, ["C1"]);
  const promise = state.mutate({
    kind: "favorite",
    channelId: "C2",
    favorite: true,
  });
  const b = ui.render("U2");
  assert.deepEqual(b.library.favoriteChannelIds, []);
  assert.equal(b.ready, false);
  ui.saved({ ...a, favoriteChannelIds: ["C1", "C2"] });
  assert.equal(await promise, false);
  assert.deepEqual(ui.render("U2").library.favoriteChannelIds, []);
});
test("保存失敗は旧libraryを保持してUIへerror、再試行成功は最新libraryを返す", async () => {
  const ui = hookHarness();
  ui.render();
  const original = emptyLibrary({ teamId: "T1", userId: "U1" });
  ui.initialize(original);
  await new Promise(setImmediate);
  let state = ui.render();
  const failed = state.mutate({ kind: "create-section", name: "開発" });
  ui.fail("保存できません");
  assert.equal(await failed, false);
  state = ui.render();
  assert.equal(state.error, "保存できません");
  assert.deepEqual(state.library.sections, []);
  const success = state.mutate({ kind: "create-section", name: "開発" });
  const latest = {
    ...original,
    sections: [{ id: "s1", name: "開発", channelIds: [] }],
  };
  ui.saved(latest);
  assert.deepEqual(await success, latest);
  assert.equal(ui.render().error, "");
});
