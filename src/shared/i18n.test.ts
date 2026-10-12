import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { messages } from "./messages.ts";
import {
  getLanguage,
  getLocale,
  setLanguage,
  systemMessage,
  t,
} from "./i18n.ts";
import { FAILURE_TITLES } from "../slack/identity.ts";
import { messageDetailBody } from "../features/hub/message-detail.ts";
import {
  aiInputHash,
  aiReasons,
  JEV_MODEL,
  AI_PROMPT_VERSION,
} from "../features/reply-priority/reply-priority-ai.ts";
import { createMessageSearchPlan } from "../features/search-scope/search-plan.ts";
import { scopeFingerprint } from "../features/search-scope/model.ts";

test("設定の日本語・英語を読み、未設定や未知の値は日本語で開く", () => {
  const exports: { configureLanguage?: () => string } = {};
  let language: unknown;
  runInNewContext(
    ts.transpileModule(readFileSync("src/shared/settings.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      require: (name: string) =>
        name === "@raycast/api"
          ? { getPreferenceValues: () => ({ language }) }
          : { setLanguage },
    },
  );
  try {
    for (const value of [undefined, "ja", "en", "unknown"]) {
      language = value;
      exports.configureLanguage!();
      assert.equal(getLanguage(), value === "en" ? "en" : "ja");
      assert.equal(getLocale(), value === "en" ? "en-US" : "ja-JP");
    }
  } finally {
    setLanguage("ja");
  }
});

test("辞書の全項目が両言語を持ち、引数を欠落させず翻訳する", () => {
  const placeholders = (text: string) => text.match(/\{\d+\}/g)?.sort() ?? [];
  for (const [key, entry] of Object.entries(messages)) {
    assert.ok(entry.ja.length > 0, key);
    assert.ok(entry.en.length > 0, key);
    assert.ok(!/[ぁ-んァ-ヶ一-龠]/.test(entry.en), key);
    assert.deepEqual(placeholders(entry.en), placeholders(entry.ja), key);
  }
});

test("切り替えは遅延評価のタイトルとエラー・日時・件数へ反映し、挿入した本文を再置換しない", () => {
  try {
    setLanguage("en");
    assert.equal(t("自分宛て"), "Mentions & DMs");
    assert.equal(t("返信待ち"), "Awaiting Reply");
    assert.equal(t("{0} 件", 46), "46 results");
    assert.equal(
      FAILURE_TITLES["missing-token"],
      "Set your Slack Access Token",
    );
    assert.equal(t("#{0}の所属", "名前 {0} $&"), "Sections for #名前 {0} $&");
    assert.equal(
      systemMessage("Slack APIの回数制限です。42秒後に再試行してください"),
      "Slack API rate limit. Retry in 42 seconds",
    );
    setLanguage("ja");
    assert.equal(
      FAILURE_TITLES["missing-token"],
      "Slack Access Tokenを設定してください",
    );
    assert.equal(
      systemMessage("Slack API rate limit. Retry in 42 seconds"),
      "Slack APIの回数制限です。42秒後に再試行してください",
    );
    assert.equal(
      systemMessage("unknown external error"),
      "unknown external error",
    );
  } finally {
    setLanguage("ja");
  }
});

test("表示言語を変えても投稿本文・検索式・AI入力hashは変わらない", () => {
  const hit = {
    key: "C1:1.000000",
    channelId: "C1",
    ts: "1.000000",
    text: "日本語の本文 {0} **bold**",
    permalink: "",
    channelKind: "channel" as const,
    mentionsSelf: false,
  };
  const scope = {
    channelIds: ["C1"],
    senderId: "U1",
    fingerprint: scopeFingerprint(["C1"], "U1"),
  };
  const plan = () =>
    createMessageSearchPlan({
      text: "議事録",
      scope,
      sources: [],
      selfId: "SELF",
    });
  const input = {
    conversation: { type: "channel" as const },
    anchorTs: "1.000000",
    messages: [{ ts: "1.000000", text: hit.text, userId: "other" }],
    asOf: "2.000000",
    timezone: "Asia/Tokyo",
    evidenceComplete: true,
    rootTs: "1.000000",
    selfId: "SELF",
  };
  try {
    setLanguage("ja");
    const body = messageDetailBody(hit, {
      user: () => undefined,
      channel: () => undefined,
    });
    const query = plan().queries;
    assert.deepEqual(query, ["議事録 in:<#C1> from:<@U1>"]);
    const hash = aiInputHash(input);
    setLanguage("en");
    assert.equal(
      messageDetailBody(hit, {
        user: () => undefined,
        channel: () => undefined,
      }),
      body,
    );
    assert.deepEqual(plan().queries, query);
    assert.equal(aiInputHash(input), hash);
    const preview = messageDetailBody(
      { ...hit, textIsPreview: true },
      { user: () => undefined, channel: () => undefined },
    );
    assert.ok(preview.startsWith("Preview (⌘R to fetch the full message)\n\n"));
    assert.ok(preview.endsWith(body));
    assert.deepEqual(
      aiReasons({
        neededProbability: 0.9,
        timeScore: 3,
        timeConfidence: 0.9,
        blockingScore: 2,
        blockingConfidence: 0.9,
        reminderProbability: 0.9,
        deadlineUncertainProbability: 0.1,
        contextIncomplete: false,
        model: JEV_MODEL,
        promptVersion: AI_PROMPT_VERSION,
      }),
      ["Deadline May Be Near", "Work May Be Blocked", "Possible Reminder"],
    );
  } finally {
    setLanguage("ja");
  }
});

test("表示対象の日本語リテラルは翻訳辞書を通し、試験データとAI指示文は対象外にする", () => {
  for (const file of readdirSync("src", { recursive: true }) as string[]) {
    if (
      !/\.(ts|tsx)$/.test(file) ||
      /(?:\.test|\.fixtures|-evaluation)\.ts$/.test(file) ||
      file === "shared/messages.ts"
    )
      continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(`src/${file}`, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node: ts.Node) {
      if (file.endsWith("reply-priority-ai.ts")) {
        let parent: ts.Node | undefined = node;
        while (parent && !ts.isFunctionDeclaration(parent))
          parent = parent.parent;
        if (
          !parent ||
          (parent as ts.FunctionDeclaration).name?.text !== "aiReasons"
        )
          return;
      }
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        /[ぁ-んァ-ヶ一-龠]/.test(node.text)
      ) {
        assert.ok(
          ts.isCallExpression(node.parent) &&
            node.parent.expression.getText(source) === "t",
          `${file}: ${node.text}`,
        );
        assert.ok(Object.hasOwn(messages, node.text), node.text);
      }
      if (ts.isTemplateExpression(node)) {
        const staticText =
          node.head.text +
          node.templateSpans.map((span) => span.literal.text).join("");
        assert.ok(
          !/[ぁ-んァ-ヶ一-龠]/.test(staticText),
          `${file}: ${staticText}`,
        );
      }
      ts.forEachChild(node, visit);
    }
    // AIモジュールだけは指示文を避け、表示用関数を起点に検査する。
    if (file.endsWith("reply-priority-ai.ts"))
      source.statements
        .filter(
          (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === "aiReasons",
        )
        .forEach(visit);
    else visit(source);
  }
});

// コマンド開始時に言語を読むので、import時には文言を固定しない。
test("表示文言をモジュール読み込み時に確定しない", () => {
  for (const file of readdirSync("src", { recursive: true }) as string[]) {
    if (
      !/\.(ts|tsx)$/.test(file) ||
      /(?:\.test|\.fixtures|-evaluation)\.ts$/.test(file)
    )
      continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(`src/${file}`, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node: ts.Node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node))
        assert.notEqual(
          node.expression.getText(source),
          "t",
          `${file}: ${node.getText(source)}`,
        );
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
