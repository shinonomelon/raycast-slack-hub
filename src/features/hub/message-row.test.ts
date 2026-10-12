import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as i18n from "../../shared/i18n.ts";
import * as compose from "../compose/compose.ts";
import * as hits from "../../slack/hits.ts";
import * as mrkdwn from "../../slack/mrkdwn.ts";
import * as detail from "./message-detail.ts";
import * as shortcuts from "./shortcuts.ts";
import { buildNames } from "../../slack/names.ts";

type Node = { type: string; props: Record<string, unknown> };
const jsx = (type: string, props: Record<string, unknown>): Node => ({
  type: String(type),
  props,
});
function render(opened: boolean, withContext: boolean) {
  const api = {
    Action: Object.assign("action", {
      Open: "open",
      Push: "push",
      OpenInBrowser: "browser",
      CopyToClipboard: "copy",
    }),
    ActionPanel: "actions",
    Color: {},
    Icon: {},
    Keyboard: { Shortcut: { Common: {} } },
    List: { Item: Object.assign("item", { Detail: "detail" }) },
  };
  const deps: Record<string, unknown> = {
    "@raycast/api": api,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "../../shared/i18n.ts": i18n,
    "../compose/compose-form.tsx": { ComposeForm: "compose" },
    "../compose/compose.ts": compose,
    "../../slack/hits.ts": hits,
    "../../slack/mrkdwn.ts": mrkdwn,
    "./message-detail.ts": detail,
    "./shortcuts.ts": shortcuts,
    "../membership/person-channels.tsx": {},
    "../membership/channel-members.tsx": {},
  };
  const exports: { MessageRow: (props: object) => Node } = {} as never;
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/hub/message-row.tsx", "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    { exports, require: (id: string) => deps[id], Date },
  );
  const marks = {
    opened: 0,
    replied: 0,
    toggled: 0,
    detail: 0,
    more: 0,
    refresh: 0,
  };
  const hit: hits.Hit = {
    key: "C1:3.000000",
    channelId: "C1",
    channelKind: "channel",
    ts: "3.000000",
    text: "selected",
    permalink: "",
    mentionsSelf: false,
  };
  const node = exports.MessageRow({
    hit,
    id: "msg:one",
    session: { display: { teamId: "T1" } },
    names: buildNames([], [], []),
    state: undefined,
    marked: false,
    showDetail: opened,
    onToggleDetail: () => marks.detail++,
    onOpen: () => marks.opened++,
    onReplied: () => marks.replied++,
    onToggleHandled: () => marks.toggled++,
    common: undefined,
    threadDetail: withContext
      ? {
          loading: false,
          data: {
            messages: [hit],
            rootTs: "1.000000",
            isThread: true,
            pages: 1,
            seen: ["next"],
            cursor: "next",
            capped: false,
          },
          more: () => marks.more++,
          refresh: () => marks.refresh++,
        }
      : undefined,
  });
  const actions: Node[] = [];
  function flatten(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(flatten);
      return;
    }
    if (!value || typeof value !== "object") return;
    const child = value as Node;
    if (["open", "action", "push", "copy", "browser"].includes(child.type))
      actions.push(child);
    else flatten(child.props.children);
  }
  flatten(node.props.actions);
  return { node, actions, marks };
}

test("追加取得があっても先頭はSlack移動、2番目は⌘Returnの詳細切替を保つ", () => {
  for (const [opened, context] of [
    [false, false],
    [true, true],
  ]) {
    const ui = render(opened, context);
    assert.equal(ui.actions[0].type, "open");
    assert.equal(
      ui.actions[1].props.title,
      i18n.t(opened ? "Hide Details" : "Show Details"),
    );
    assert.deepEqual(ui.actions[1].props.shortcut, shortcuts.DETAILS_SHORTCUT);
    (ui.actions[1].props.onAction as () => void)();
    assert.equal(ui.marks.detail, 1);
    assert.equal(ui.marks.opened, 0);
    assert.equal(ui.marks.toggled, 0);
  }
});

test("追加取得・詳細更新は専用操作へ進み、返信は取得した親へ向ける", () => {
  const ui = render(true, true);
  (
    ui.actions.find(
      (action) => action.props.title === i18n.t("過去の投稿をさらに取得"),
    )!.props.onAction as () => void
  )();
  (
    ui.actions.find((action) => action.props.title === i18n.t("詳細を更新"))!
      .props.onAction as () => void
  )();
  assert.equal(ui.marks.more, 1);
  assert.equal(ui.marks.refresh, 1);
  assert.equal(ui.marks.opened, 0);
  const reply = ui.actions.find(
    (action) => action.props.title === i18n.t("Reply in Thread"),
  )!;
  const form = reply.props.target as Node;
  assert.equal((form.props.reply as { threadTs: string }).threadTs, "1.000000");
  assert.equal((form.props.target as { id: string }).id, "C1");
  assert.deepEqual(reply.props.shortcut, shortcuts.REPLY_SHORTCUT);
  assert.ok(
    String(ui.actions[0].props.target).includes(
      "message=3.000000&thread_ts=1.000000",
    ),
  );
});
