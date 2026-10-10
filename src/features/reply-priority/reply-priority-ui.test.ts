import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 実際の画面を外部通信なしで動かし、Actionから送信・反映の境界を検証する。
type Node = { type: string; props: Record<string, unknown> };
function harness(restored = false) {
  const slots: unknown[] = [];
  let cursor = 0;
  let consent = false;
  let valid = true;
  let scoring = 0;
  let refreshes = 0;
  let continues = 0;
  let resolveScore: (value: unknown) => void = () => {};
  const effects: (() => void)[] = [];
  const jsx = (type: string, props: Record<string, unknown>): Node => ({
    type,
    props,
  });
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (next: unknown) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      return slots[index] ?? (slots[index] = { current: initial });
    },
    useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => void) => {
      if (!rendered) effects.push(fn);
    },
  };
  const candidate = {
    key: "c1",
    hit: { text: "依頼" },
    messages: [],
    section: "pending",
  };
  const source = {
    loading: false,
    invalidated: false,
    cacheEpoch: restored ? 1 : 0,
    snapshot: {
      candidates: [candidate],
      pendingCount: 1,
      asOf: "100",
      pausedUntil: 0,
    },
    store: { loadPause: () => 0 },
    marks: {},
    guard: () => valid,
    saveAI: () => {},
    loadAI: () =>
      restored
        ? [
            {
              key: "c1",
              hash: "hash",
              applied: true,
              result: {},
              scoredAt: Date.now(),
            },
          ]
        : [],
    refresh: () => {
      refreshes++;
    },
    continueScan: () => {
      continues++;
    },
    cancelScan: () => {},
  };
  const api = {
    Action: Object.assign("Action", { Open: "Open" }),
    ActionPanel: "ActionPanel",
    Alert: { ActionStyle: { Default: "default" } },
    confirmAlert: async () => consent,
    Icon: {},
    Keyboard: { Shortcut: { Common: { Refresh: {} } } },
    List: Object.assign("List", {
      EmptyView: "Empty",
      Section: "Section",
      Item: "Item",
      Dropdown: Object.assign("Dropdown", { Item: "DropdownItem" }),
    }),
    useNavigation: () => ({ push: () => {} }),
    openExtensionPreferences: () => {},
    showToast: () => {},
    Toast: { Style: { Failure: "failure" } },
  };
  const deps: Record<string, unknown> = {
    "@raycast/api": api,
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "../../shared/settings.ts": {
      readReplyAISettings: () => ({ typesafeApiKey: "fixture-key" }),
    },
    "./use-reply-priority.ts": { useReplyPriority: () => source },
    "./reply-priority-ai.ts": {
      aiInputHash: () => "hash",
      createJevScorer: () => ({}),
      scoreAIRound: () => {
        scoring++;
        return new Promise((resolve) => {
          resolveScore = resolve;
        });
      },
    },
    "./reply-priority-view.ts": {
      evidenceComplete: () => true,
      replySections: (
        candidates: (typeof candidate)[],
        _m: unknown,
        results: Map<string, unknown>,
        applied: boolean,
      ) =>
        candidates.map((item) => ({
          ...item,
          section: applied && results.size ? "needed" : "pending",
        })),
      filterReplyRows: (rows: unknown) => rows,
      replyDisplayAfter: (state: object, event: string) => ({
        ...state,
        aiApplied: event === "apply",
        filter: "all",
      }),
    },
    "./reply-priority-row.tsx": { ReplyPriorityRow: "Row" },
    "./reply-priority-cache.ts": { reusableReplyAI: () => true },
    "../../slack/mrkdwn.ts": { toPlain: (text: string) => text },
  };
  const compiled = ts.transpileModule(
    readFileSync(
      "src/features/reply-priority/reply-priority-screen.tsx",
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports: Record<string, (props: unknown) => Node> = {};
  runInNewContext(compiled, {
    exports,
    require: (id: string) => deps[id] ?? {},
    AbortController,
    Date,
    Map,
    Set,
    Intl,
  });
  let rendered = false;
  let tree: Node;
  const render = () => {
    cursor = 0;
    tree = exports.ReplyPriorityScreen({
      context: {
        people: [],
        session: { canFetch: true, display: { userId: "self" } },
        names: { sender: () => "相手", conversationLabel: () => "DM" },
      },
      initialToken: "token",
    });
    rendered = true;
    while (effects.length) effects.shift()!();
    return tree;
  };
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [node, ...Object.values(node.props).flatMap(nodes)];
  }
  const action = (title: string) => {
    const match = nodes(tree).find((node) => node.props.title === title);
    assert.ok(
      match,
      title + JSON.stringify(nodes(tree).filter((n) => n.type === "Empty")),
    );
    return (match.props.onAction as () => unknown)();
  };
  return {
    render,
    action,
    nodes: () => nodes(tree),
    source,
    accept: () => {
      consent = true;
    },
    invalidate: () => {
      valid = false;
    },
    failAuth: () =>
      resolveScore({
        results: new Map([["c1", { kind: "failed", reason: "auth" }]]),
        remaining: ["c2"],
        stopped: "auth",
      }),
    fail: (rate = false) =>
      resolveScore({
        results: new Map([
          [
            "c1",
            {
              kind: "failed",
              reason: rate ? "rate" : "auth",
              retryAfterMs: 60000,
            },
          ],
        ]),
        remaining: [],
        stopped: rate ? "rate" : undefined,
      }),
    complete: () =>
      resolveScore({
        results: new Map([["c1", { kind: "ok", result: {} }]]),
        remaining: [],
      }),
    get scoring() {
      return scoring;
    },
    get refreshes() {
      return refreshes;
    },
    get continues() {
      return continues;
    },
  };
}

test("表示・更新・続きを確認ではAIへ送らず、同意拒否で送信0", async () => {
  const ui = harness();
  ui.render();
  ui.action("Reload Reply Candidates");
  ui.action("続きを確認");
  await ui.action("AIで並べる・再試行");
  assert.equal(ui.scoring, 0);
  assert.equal(ui.refreshes, 1);
  assert.equal(ui.continues, 1);
});

test("同意後の判定は明示反映まで順位を変えず選択を維持する", async () => {
  const ui = harness();
  ui.render();
  ui.accept();
  const list = ui
    .nodes()
    .find((node) => node.props.navigationTitle === "返信待ち")!;
  (list.props.onSelectionChange as (id: string) => void)("c1");
  ui.render();
  const promise = ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  ui.render();
  ui.complete();
  await promise;
  await new Promise(setImmediate);
  ui.render();
  assert.equal(
    ui.scoring,
    1,
    JSON.stringify(ui.nodes().filter((n) => n.type === "Empty")),
  );
  assert.equal(
    ui.nodes().find((node) => node.type === "Row")!.props.candidate &&
      (
        ui.nodes().find((node) => node.type === "Row")!.props.candidate as {
          section: string;
        }
      ).section,
    "pending",
  );
  ui.action("AI判定を反映");
  ui.render();
  assert.equal(
    (
      ui.nodes().find((node) => node.type === "Row")!.props.candidate as {
        section: string;
      }
    ).section,
    "needed",
  );
  assert.equal(
    ui.nodes().find((node) => node.props.navigationTitle === "返信待ち")!.props
      .selectedItemId,
    "c1",
  );
});

test("中断または設定境界失効の後に届いたAI結果は反映Actionを出さない", async () => {
  for (const kind of ["cancel", "settings"]) {
    const ui = harness();
    ui.render();
    ui.accept();
    const promise = ui.action("AIで並べる・再試行");
    await new Promise(setImmediate);
    ui.render();
    if (kind === "cancel") {
      ui.action("AI判定を中断");
      ui.render();
      assert.match(
        String(
          ui.nodes().find((node) => node.props.id === "reply-priority-problem")!
            .props.title,
        ),
        /中断しました。再試行/,
      );
    } else ui.invalidate();
    ui.complete();
    await promise;
    await new Promise(setImmediate);
    ui.render();
    assert.equal(
      ui.nodes().some((node) => node.props.title === "AI判定を反映"),
      false,
    );
  }
});

test("反映済みキャッシュを開き直しても送信同意を復元しない", async () => {
  const ui = harness(true);
  ui.render();
  ui.render();
  assert.equal(ui.scoring, 0);
  assert.equal(
    (
      ui.nodes().find((node) => node.type === "Row")!.props.candidate as {
        section: string;
      }
    ).section,
    "needed",
  );
  await ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  assert.equal(ui.scoring, 0);
});

test("同意ダイアログを待つ間に設定境界が失効すると送信0", async () => {
  const ui = harness();
  ui.render();
  ui.accept();
  ui.action("AIで並べる・再試行");
  ui.invalidate();
  await new Promise(setImmediate);
  assert.equal(ui.scoring, 0);
});

test("行のReturnはSlackを開き、cmdReturn詳細・返信・不要・延期・取消を分ける", () => {
  const jsx = (type: string, props: Record<string, unknown>): Node => ({
    type,
    props,
  });
  const exports: Record<string, (props: unknown) => Node> = {};
  const deps: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "@raycast/api": {
      Action: Object.assign("Action", { Open: "Open" }),
      ActionPanel: "Panel",
      Icon: {},
      List: { Item: Object.assign("Item", { Detail: "Detail" }) },
    },
    "../../slack/hits.ts": { messageLink: () => "slack://fixture" },
    "../../slack/mrkdwn.ts": {
      toPlain: (value: string) => value,
      toMarkdown: (value: string) => value,
    },
    "../hub/shortcuts.ts": {
      DETAILS_SHORTCUT: { modifiers: ["cmd"], key: "return" },
      REPLY_SHORTCUT: { modifiers: ["cmd", "shift"], key: "return" },
    },
    "./reply-priority-view.ts": { replyRoot: () => "100" },
  };
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        "src/features/reply-priority/reply-priority-row.tsx",
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    { exports, require: (id: string) => deps[id] ?? {}, Date, Math },
  );
  const called: string[] = [];
  const props = {
    candidate: {
      key: "c1",
      hit: { text: "依頼" },
      messages: [],
      evidence: { kind: "no-self-post" },
      firstPendingTs: "100",
      section: "pending",
    },
    context: {
      session: { canFetch: true, display: {} },
      names: {
        conversationLabel: () => "DM",
        sender: () => "相手",
        lookup: {},
      },
    },
    showDetail: false,
    asOf: "100",
    onToggleDetail: () => called.push("detail"),
    onReply: () => called.push("reply"),
    onDismiss: () => called.push("dismiss"),
    onSnooze: (kind: string) => called.push(kind),
    onUndo: () => called.push("undo"),
  };
  const actions = (row: Node) => {
    const panel = row.props.actions as Node;
    const collect = (value: unknown): Node[] => {
      if (Array.isArray(value)) return value.flatMap(collect);
      if (!value || typeof value !== "object" || !("props" in value)) return [];
      const node = value as Node;
      return [node, ...collect(node.props.children)];
    };
    return collect(panel.props.children).filter((node) => node.props.title);
  };
  const visible = actions(exports.ReplyPriorityRow(props));
  assert.equal(visible[0].type, "Open");
  assert.equal(visible[0].props.target, "slack://fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(visible[1].props.shortcut)), {
    modifiers: ["cmd"],
    key: "return",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(visible[2].props.shortcut)), {
    modifiers: ["cmd", "shift"],
    key: "return",
  });
  for (const title of [
    "Show Details",
    "Reply in Thread",
    "返信不要",
    "あとで対応・1時間",
    "あとで対応・翌朝9時",
  ]) {
    (
      visible.find((node) => node.props.title === title)!.props
        .onAction as () => void
    )();
  }
  assert.deepEqual(called, ["detail", "reply", "dismiss", "hour", "tomorrow"]);
  const hidden = actions(
    exports.ReplyPriorityRow({
      ...props,
      candidate: { ...props.candidate, section: "hidden" },
    }),
  );
  assert.equal(
    hidden.some((node) => node.props.title === "返信不要"),
    false,
  );
  (
    hidden.find((node) => node.props.title === "除外・延期を取り消す")!.props
      .onAction as () => void
  )();
  assert.equal(called.at(-1), "undo");
});

test("候補があるAI失敗画面に再試行の案内を出し、通常説明を復活させない", async () => {
  const ui = harness();
  ui.render();
  assert.equal(
    ui.nodes().some((n) => n.props.id === "reply-priority-problem"),
    false,
  );
  ui.accept();
  ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  ui.fail();
  await new Promise(setImmediate);
  ui.render();
  assert.match(
    String(
      ui.nodes().find((n) => n.props.id === "reply-priority-problem")!.props
        .title,
    ),
    /再試行/,
  );
  assert.equal(
    ui.nodes().some((n) => n.type === "Row"),
    true,
  );
  const text = JSON.stringify(ui.nodes());
  for (const removed of [
    "取得基準",
    "同じ会話",
    "AI未判定",
    "確信度",
    "候補内順序",
  ])
    assert.equal(text.includes(removed), false);
});

test("Slack429は候補と再開時刻を表示し、待機中Continueで取得0", () => {
  const ui = harness();
  ui.source.snapshot.pausedUntil = Date.now() + 60000;
  ui.render();
  assert.match(
    String(
      ui.nodes().find((n) => n.props.id === "reply-priority-problem")!.props
        .title,
    ),
    /Slackの回数制限。.*以降に「続きを確認」/,
  );
  ui.action("続きを確認");
  assert.equal(ui.continues, 0);
  ui.source.snapshot.pausedUntil = 0;
  ui.render();
  ui.action("続きを確認");
  assert.equal(ui.continues, 1);
});

test("AI429は再開時刻と操作を表示し、待機中の再試行で追加送信0", async () => {
  const ui = harness();
  ui.render();
  ui.accept();
  ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  ui.fail(true);
  await new Promise(setImmediate);
  ui.render();
  assert.match(
    String(
      ui.nodes().find((n) => n.props.id === "reply-priority-problem")!.props
        .title,
    ),
    /AIの回数制限。.*以降に「AIで並べる・再試行」/,
  );
  ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  assert.equal(ui.scoring, 1);
});

test("複数候補と未判定が残る認証失敗を、件数表示で隠さずキー更新案内にする", async () => {
  const ui = harness();
  ui.source.snapshot.candidates.push({
    ...ui.source.snapshot.candidates[0],
    key: "c2",
  });
  ui.render();
  ui.accept();
  ui.action("AIで並べる・再試行");
  await new Promise(setImmediate);
  ui.failAuth();
  await new Promise(setImmediate);
  ui.render();
  const problem = String(
    ui.nodes().find((node) => node.props.id === "reply-priority-problem")!.props
      .title,
  );
  assert.match(problem, /TypeSafeの認証に失敗/);
  assert.match(problem, /API Keyを確認・更新.*Slack Hubを開き直し/);
  assert.equal(problem.includes("未判定"), false);
  assert.equal(ui.nodes().filter((node) => node.type === "Row").length, 2);
});
