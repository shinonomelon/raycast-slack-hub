import * as i18n from "../../shared/i18n.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ChannelLibrary } from "../channel-library/model.ts";
import { DEFAULT_SEARCH_SCOPE, validateScopeSelection } from "./model.ts";

type Node = { type: string; props: Record<string, unknown> };
const jsx = (type: string, props: Record<string, unknown>): Node => ({
  type,
  props,
});
const initial: ChannelLibrary = {
  version: 1,
  teamId: "T1",
  userId: "U1",
  favoriteChannelIds: [],
  sections: [],
};

// 実際の親画面の管理コールバックとフォームを動かし、フォームへ戻った後の再オープンを確認する。
function harness(parent: "hub" | "reply-priority") {
  const path =
    parent === "hub"
      ? "src/features/hub/hub-screen.tsx"
      : "src/features/reply-priority/reply-priority-screen.tsx";
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let manage = "";
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "onManage" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    ) {
      manage = node.initializer.expression!.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(manage);
  let current = initial;
  let next = initial;
  const pushed: Node[] = [];
  const mutation = async () => (current = next);
  const exports: {
    manage?: (
      library: ChannelLibrary,
      onChange: (library: ChannelLibrary) => void,
    ) => void;
  } = {};
  runInNewContext(
    ts.transpileModule(`export const manage = ${manage}`, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
    {
      exports,
      require: () => ({ jsx, jsxs: jsx }),
      push: (node: Node) => pushed.push(node),
      SectionScreen: "SectionScreen",
      library:
        parent === "hub" ? { library: initial, mutate: mutation } : initial,
      conversations: { data: [] },
      scopeControls: { conversations: [], onMutate: mutation },
      libraryRef: { current: initial },
      setLibrary: (value: ChannelLibrary) => {
        current = value;
      },
    },
  );
  const slots: unknown[] = [];
  let cursor = 0;
  const formExports: { ScopeForm?: (props: unknown) => Node } = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/search-scope/scope-form.tsx", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    {
      exports: formExports,
      require: (id: string) =>
        id.endsWith("/i18n.ts")
          ? i18n
          : {
              "react/jsx-runtime": { jsx, jsxs: jsx },
              "@raycast/api": {
                Action: "Action",
                ActionPanel: "ActionPanel",
                Form: Object.assign("Form", {
                  Dropdown: Object.assign("Dropdown", { Item: "Item" }),
                  Description: "Description",
                }),
                useNavigation: () => ({ pop: () => {} }),
              },
              react: {
                useState: (initialValue: unknown) => {
                  const index = cursor++;
                  if (!(index in slots)) slots[index] = initialValue;
                  return [
                    slots[index],
                    (value: unknown) => {
                      slots[index] = value;
                    },
                  ];
                },
              },
              "./model.ts": { DEFAULT_SEARCH_SCOPE, validateScopeSelection },
            }[id],
    },
  );
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [node, ...Object.values(node.props).flatMap(nodes)];
  }
  let lastForm: Node;
  function open() {
    cursor = 0;
    const tree = formExports.ScopeForm!({
      scope: DEFAULT_SEARCH_SCOPE,
      library: initial,
      conversations: [],
      people: [],
      onApply: () => {},
      onManage: exports.manage,
    });
    lastForm = tree;
    const action = nodes(tree).find(
      (node) => node.props.title === i18n.t("セクションを管理"),
    )!;
    (action.props.onAction as () => void)();
    return pushed.at(-1)!;
  }
  return {
    open,
    formNodes: () => nodes(lastForm),
    update: async (section: ChannelLibrary["sections"][number]) => {
      next = { ...current, sections: [section] };
      await (
        pushed.at(-1)!.props.onMutate as (mutation: unknown) => Promise<unknown>
      )({ kind: "create-section", name: section.name });
      return next;
    },
  };
}

for (const parent of ["hub", "reply-priority"] as const) {
  test(`${parent}の条件フォームは管理画面で作成・更新後に戻って開き直すと最新一覧を渡す`, async () => {
    const ui = harness(parent);
    assert.equal(ui.open().props.library, initial);
    const created = await ui.update({ id: "s1", name: "新規", channelIds: [] });
    assert.equal(ui.open().props.library, created);
    const renamed = await ui.update({
      id: "s1",
      name: "更新済み",
      channelIds: ["C1"],
    });
    assert.equal(ui.open().props.library, renamed);
  });
}

test("英語の検索条件フォームは項目・操作を英語にし、管理後の利用者のセクション名は保持する", async () => {
  try {
    i18n.setLanguage("en");
    const ui = harness("hub");
    ui.open();
    const form = ui.formNodes();
    assert.equal(form[0].props.navigationTitle, "Choose Search Filters");
    const titles = form.map((node) => node.props.title);
    for (const title of [
      "Apply",
      "Show Messages",
      "Clear Filters and Apply",
      "Manage Sections",
      "Search Scope",
      "Sender",
    ])
      assert.ok(titles.includes(title), title);
    const updated = await ui.update({
      id: "s1",
      name: "日本語のセクション",
      channelIds: ["C1"],
    });
    assert.equal(ui.open().props.library, updated);
    assert.equal(updated.sections[0].name, "日本語のセクション");
  } finally {
    i18n.setLanguage("ja");
  }
});
