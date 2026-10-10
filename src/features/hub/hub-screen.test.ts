import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as orderFunctions from "./view-order.ts";

// 実際のHubの描画部分を使い、Raycast本体を起動せず検索条件変更中の行を検査する。
// JSXは値として受け取り、通信や画面操作は行わない。
const source = readFileSync("src/features/hub/hub-screen.tsx", "utf8");
const marker = source.indexOf("// メッセージ：検索結果");
const start = source.indexOf("        if (!statusRow", marker);
const end = source.indexOf("\n      })}", start);
assert.ok(marker >= 0 && start >= 0 && end > start);
const guard = source.match(/ {2}const messageHits =[\s\S]*?;\n/)?.[0] ?? "";
const compiled = ts.transpileModule(
  `export function render(search, resolved, session, rows, statusRow) {
    const List = { Section: "section" };
    const filterLabels = resolved.filters.map(f => f.modifier + ":" + f.label).join(" ");
    const messageRow = hit => { rows.push(hit); return hit; };
    const messageRowId = hit => hit.key;
    const triage = { marks: new Set() };
    ${guard}
    ${source.slice(start, end)}
  }`,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
type Search = { query?: string; hits: { key: string; channelId: string }[] };
type Section = { props: { subtitle?: string } } | null;
const moduleExports = {} as {
  render: (
    search: Search,
    resolved: { query: string; filters: { modifier: string; label: string }[] },
    session: { canFetch: boolean },
    rows: Search["hits"],
    statusRow: unknown,
  ) => Section;
};
runInNewContext(compiled, {
  exports: moduleExports,
  require: (name: string) => {
    assert.equal(name, "react/jsx-runtime");
    const jsx = (type: unknown, props: unknown) => ({ type, props });
    return { jsx, jsxs: jsx };
  },
});

const a = { key: "CA:1", channelId: "CA" };
const b = { key: "CB:2", channelId: "CB" };
function render(search: Search, query: string, statusRow?: unknown) {
  const rows: Search["hits"] = [];
  const section = moduleExports.render(
    search,
    { query, filters: [{ modifier: "in", label: query }] },
    { canFetch: true },
    rows,
    statusRow,
  );
  return { rows, section };
}

test("Hubは条件変更直後と取得待ちの間に前の条件のメッセージを表示しない", () => {
  const previous = { query: "alpha", hits: [a] };
  assert.deepEqual(render(previous, "alpha").rows, [a]);
  assert.deepEqual(render(previous, "bravo").rows, []);
  assert.equal(render(previous, "bravo").section, null);
  // 新条件の停止・失敗のお知らせが出ても、古い投稿をその下に残さない。
  assert.deepEqual(render(previous, "bravo", "status").rows, []);
  const current = render({ query: "bravo", hits: [b] }, "bravo");
  assert.deepEqual(current.rows, [b]);
  assert.equal(current.section?.props.subtitle, "in:bravo · 1 件");
});

test("Hubは同じ検索式の再取得中にはその検索結果を表示できる", () => {
  assert.deepEqual(render({ query: "alpha", hits: [a] }, "alpha").rows, [a]);
});

// 純粋関数のテストに加え、Hubの描画順・操作・選択予約が同じモードを渡すことを実際のコールバックで検査する。
function orderHarness() {
  const ast = ts.createSourceFile(
    "hub-screen.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = new Map<string, string>();
  let onApply = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer)
      declarations.set(node.name.getText(ast), node.initializer.getText(ast));
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === "onApply" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    )
      onApply = node.initializer.expression!.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const key of ["order", "swapOrder", "changeSearchText"])
    assert.ok(declarations.has(key), key);
  assert.ok(onApply);
  type Request = { text: string; section: string };
  const context = {
    searchText: "",
    messageMode: false,
    override: undefined as unknown,
    candidates: [] as unknown[],
    hasTopSection: false,
    request: undefined as Request | undefined,
    ...orderFunctions,
    setSearchScope: () => {},
    setMessageMode: (value: boolean) => {
      context.messageMode = value;
    },
    setSearchText: (value: string) => {
      context.searchText = value;
    },
    setOverride: (value: unknown) => {
      context.override = value;
    },
    setRequest: (value: Request) => {
      context.request = value;
    },
    hasCandidatesFor: () => context.candidates.length > 0,
    exports: {} as {
      order: () => string[];
      swap: () => void;
      change: (text: string) => void;
      apply: (scope: object, options: { showMessages?: boolean }) => void;
    },
  };
  runInNewContext(
    ts.transpileModule(
      `export function order() { return ${declarations.get("order")}; }
    export const swap = ${declarations.get("swapOrder")};
    export const change = ${declarations.get("changeSearchText")};
    export const apply = ${onApply};`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS } },
    ).outputText,
    context,
  );
  return context;
}

test("Hubのメッセージ表示操作は初期表示・双方向swap・文字変更・候補の表示順と先頭選択を整合させる", () => {
  const ui = orderHarness();
  ui.exports.apply({ range: { kind: "favorites" } }, { showMessages: true });
  const assertFirst = (
    section: "messages" | "conversations" | "candidates",
  ) => {
    assert.equal(ui.exports.order()[0], section);
    assert.equal(ui.request?.section, section);
    const selected = orderFunctions.decideSelection(
      ui.request as orderFunctions.SelectionRequest,
      {
        text: ui.searchText,
        query: "query",
        search: { query: "query", status: undefined },
        firstIds: {
          messages: "msg:1",
          conversations: "conv:1",
          candidates: "cand:1",
        },
      },
    );
    assert.equal(
      selected.selectedId,
      section === "messages"
        ? "msg:1"
        : section === "conversations"
          ? "conv:1"
          : "cand:1",
    );
  };
  assertFirst("messages");
  ui.exports.swap();
  assertFirst("conversations");
  ui.exports.change("請求");
  assertFirst("conversations");
  ui.exports.swap();
  assertFirst("messages");
  ui.candidates.push({});
  ui.hasTopSection = true;
  ui.exports.swap();
  assertFirst("candidates");
  ui.exports.swap();
  assertFirst("candidates");
});

// setterは次の描画値だけを更新し、Actionが捕捉した古い描画値は保持する。
function channelEntryHarness(
  searchText: string,
  messageMode: boolean,
  override: orderFunctions.OrderedSection | undefined,
) {
  const ast = ts.createSourceFile(
    "hub-screen.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let change = "";
  let entry = "";
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "changeSearchText"
    )
      change = node.initializer!.getText(ast);
    if (ts.isJsxSelfClosingElement(node)) {
      const title = node.attributes.properties.find(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(ast) === "title",
      );
      if (
        title &&
        ts.isJsxAttribute(title) &&
        title.initializer &&
        ts.isStringLiteral(title.initializer) &&
        title.initializer.text === "このチャンネルでメッセージを検索"
      ) {
        const action = node.attributes.properties.find(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(ast) === "onAction",
        ) as ts.JsxAttribute;
        entry = (action.initializer as ts.JsxExpression).expression!.getText(
          ast,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(change);
  assert.ok(entry);
  const next = {
    searchText,
    messageMode,
    override,
    scope: { range: { kind: "all" } },
    request: undefined as orderFunctions.SelectionRequest | undefined,
  };
  const exports: { create?: (state: object) => () => void } = {};
  runInNewContext(
    ts.transpileModule(
      `export function create({searchText, messageMode, override, searchScope}) {
    const changeSearchText = ${change};
    return ${entry};
  }`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS } },
    ).outputText,
    {
      exports,
      ...orderFunctions,
      item: { id: "C1" },
      setSearchScope: (scope: typeof next.scope) => {
        next.scope = scope;
      },
      setSearchText: (text: string) => {
        next.searchText = text;
      },
      setMessageMode: (mode: boolean) => {
        next.messageMode = mode;
      },
      setOverride: (value: typeof override) => {
        next.override = value;
      },
      setRequest: (request: orderFunctions.SelectionRequest) => {
        next.request = request;
      },
      hasCandidatesFor: () => false,
    },
  );
  return {
    next,
    action: exports.create!({
      searchText,
      messageMode,
      override,
      searchScope: next.scope,
    }),
  };
}

for (const messageMode of [false, true]) {
  test(`チャンネルのメッセージ検索入口は旧messageMode=${messageMode}・会話優先からメッセージ優先と先頭選択へ切り替える`, () => {
    const ui = channelEntryHarness("請求", messageMode, "conversations");
    ui.action();
    assert.equal(ui.next.messageMode, true);
    assert.equal(ui.next.searchText, "");
    assert.equal(
      orderFunctions.sectionOrder(
        ui.next.searchText,
        ui.next.override,
        false,
        ui.next.messageMode,
      )[0],
      "messages",
    );
    assert.equal(ui.next.request?.section, "messages");
    assert.equal(
      orderFunctions.decideSelection(ui.next.request, {
        text: "",
        query: "query",
        search: { query: "query", status: undefined },
        firstIds: {
          messages: "msg:1",
          conversations: "conv:1",
          triage: "tome:1",
        },
      }).selectedId,
      "msg:1",
    );
  });
}
