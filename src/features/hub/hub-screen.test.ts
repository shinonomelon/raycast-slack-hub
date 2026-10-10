import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
