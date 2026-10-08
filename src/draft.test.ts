import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildDraftArgs,
  classifyDraftResult,
  classifyDraftRunError,
  DRAFT_DIR_PREFIX,
  ensureBlankLineAfterLists,
  MCP_REQUEST_ERROR,
  saveDraft,
} from "./draft.ts";
import { SEND_DIR_PREFIX, STALE_SEND_DIR_MS } from "./post.ts";
import type { CliResult } from "./types.ts";

const result = (overrides: Partial<CliResult>): CliResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

// ---- ensureBlankLineAfterLists ----------------------------------------------------

test("ensureBlankLineAfterLists: 箇条書きの直後の行の前に空行を足す", () => {
  assert.equal(
    ensureBlankLineAfterLists("- 1つ目\n- 2つ目\n見終えたら消す"),
    "- 1つ目\n- 2つ目\n\n見終えたら消す",
  );
  assert.equal(
    ensureBlankLineAfterLists("1. 一\n2) 二\n次の段落"),
    "1. 一\n2) 二\n\n次の段落",
  );
});

test("ensureBlankLineAfterLists: 空行がある・字下げした続きの行・箇条書きだけのときは変えない", () => {
  for (const md of [
    "- 1つ目\n- 2つ目\n\n見終えたら消す",
    "- 1つ目\n  続きの行\n- 2つ目",
    "- 1つ目\n- 2つ目",
    "本文だけ\n2行目",
    "",
  ]) {
    assert.equal(ensureBlankLineAfterLists(md), md);
  }
});

test("ensureBlankLineAfterLists: 全角の空白で始まる行は項目の続きにしない", () => {
  assert.equal(
    ensureBlankLineAfterLists("- 1つ目\n\u3000見終えたら消す"),
    "- 1つ目\n\n\u3000見終えたら消す",
  );
});

test("ensureBlankLineAfterLists: コードブロックの中は変えない", () => {
  const code = "```\n- 1つ目\nつながる行\n```";
  assert.equal(ensureBlankLineAfterLists(code), code);
  const tilde = "~~~\n- a\nb\n~~~\n- c\nd";
  assert.equal(ensureBlankLineAfterLists(tilde), "~~~\n- a\nb\n~~~\n- c\n\nd");
});

test("ensureBlankLineAfterLists: 箇条書きの直後のコードブロックの前にも空行を足し、中は変えない", () => {
  assert.equal(
    ensureBlankLineAfterLists("- 1つ目\n```\n- x\ny\n```"),
    "- 1つ目\n\n```\n- x\ny\n```",
  );
});

// ---- buildDraftArgs ---------------------------------------------------------------

test("buildDraftArgs: 会話は -c、人は --user-id。返信なら -t。いつも --format json", () => {
  assert.deepEqual(
    buildDraftArgs({
      target: { kind: "conversation", id: "C123" },
      file: "/tmp/m.md",
    }),
    ["draft", "-c", "C123", "--file", "/tmp/m.md", "--format", "json"],
  );
  assert.deepEqual(
    buildDraftArgs({
      target: { kind: "person", id: "U456" },
      file: "/tmp/m.md",
    }),
    ["draft", "--user-id", "U456", "--file", "/tmp/m.md", "--format", "json"],
  );
  assert.deepEqual(
    buildDraftArgs({
      target: { kind: "conversation", id: "C123" },
      file: "/tmp/m.md",
      threadTs: "1791327335.337259",
    }),
    [
      "draft",
      "-c",
      "C123",
      "--file",
      "/tmp/m.md",
      "-t",
      "1791327335.337259",
      "--format",
      "json",
    ],
  );
});

// ---- classifyDraftResult ----------------------------------------------------------

test("classifyDraftResult: draftId のある JSON は saved", () => {
  const stdout = JSON.stringify(
    {
      draftId: "Dr0C8AQGBPKJ",
      channelId: "C0000000002",
      threadTs: "1791327335.337259",
    },
    null,
    2,
  );
  assert.deepEqual(classifyDraftResult(result({ stdout })), {
    kind: "saved",
    draftId: "Dr0C8AQGBPKJ",
    channelId: "C0000000002",
    threadTs: "1791327335.337259",
  });
  assert.deepEqual(
    classifyDraftResult(
      result({
        stdout: '{"draftId":"Dr1","channelId":"D1","threadTs":null}',
      }),
    ),
    { kind: "saved", draftId: "Dr1", channelId: "D1", threadTs: null },
  );
});

test("classifyDraftResult: 終了コード 0 でも draftId が読めなければ unconfirmed", () => {
  for (const stdout of ["", "✓ Draft saved", '{"channelId":"C1"}']) {
    assert.equal(classifyDraftResult(result({ stdout })).kind, "unconfirmed");
  }
});

test("classifyDraftResult: 終了コード 1 は failed で、エラー文を出す", () => {
  const outcome = classifyDraftResult(
    result({
      code: 1,
      stderr:
        "✗ Error: Slack did not return a draft_id, so the draft was not created. The conversation may already have a draft\n",
    }),
  );
  assert.deepEqual(outcome, {
    kind: "failed",
    message:
      "Slack did not return a draft_id, so the draft was not created. The conversation may already have a draft",
  });
});

test("classifyDraftResult: 時間切れ・中断・シグナルは unconfirmed", () => {
  assert.equal(
    classifyDraftResult(
      result({ code: null, signal: "SIGTERM", timedOut: true }),
    ).kind,
    "unconfirmed",
  );
  assert.equal(
    classifyDraftResult(
      result({ code: null, signal: "SIGTERM", aborted: true }),
    ).kind,
    "unconfirmed",
  );
  assert.equal(
    classifyDraftResult(result({ code: null, signal: "SIGKILL" })).kind,
    "unconfirmed",
  );
});

test("classifyDraftResult: slack-cli の通信の失敗の印は unconfirmed", () => {
  // slack-cli の側（slack-mcp-client.ts）と同じ文字列そのものを確かめる
  assert.equal(MCP_REQUEST_ERROR, "Slack MCP request error:");
  const outcome = classifyDraftResult(
    result({
      code: 1,
      stderr:
        "\u001b[31m✗ Error:\u001b[39m Slack MCP request error: TypeError: fetch failed\n",
    }),
  );
  assert.equal(outcome.kind, "unconfirmed");
  assert.match(
    (outcome as { message: string }).message,
    /Slack MCP request error: TypeError: fetch failed/,
  );
});

test("classifyDraftResult: draft を持たない slack-cli は、新しくするよう出す", () => {
  const outcome = classifyDraftResult(
    result({ code: 1, stderr: "error: unknown command 'draft'\n" }),
  );
  assert.equal(outcome.kind, "failed");
  assert.match(
    (outcome as { message: string }).message,
    /draft コマンドがありません/,
  );
});

test("classifyDraftRunError: 起動できなかったときだけ failed、それ以外は unconfirmed", () => {
  const spawnError = Object.assign(new Error("spawn node ENOENT"), {
    code: "ENOENT",
    syscall: "spawn node",
  });
  assert.equal(classifyDraftRunError(spawnError).kind, "failed");
  assert.equal(
    classifyDraftRunError(new Error("maxBuffer exceeded")).kind,
    "unconfirmed",
  );
});

// ---- saveDraft --------------------------------------------------------------------

test("saveDraft: メンションと空行を足した本文をファイルで渡し、結果を分類して、一時フォルダを消す", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-flow-"));
  try {
    let args: string[] = [];
    let written = "";
    const { outcome, markdown } = await saveDraft({
      target: { kind: "conversation", id: "C123" },
      mentionIds: ["U1"],
      markdown: "- 1つ目\n- 2つ目\n見終えたら消す",
      tmpRoot: root,
      threadTs: "1791327335.337259",
      run: async (a) => {
        args = a;
        written = await readFile(a[a.indexOf("--file") + 1], "utf8");
        return result({
          stdout:
            '{"draftId":"Dr1","channelId":"C123","threadTs":"1791327335.337259"}',
        });
      },
    });

    assert.equal(markdown, "<@U1>\n\n- 1つ目\n- 2つ目\n\n見終えたら消す");
    assert.equal(written, markdown);
    assert.deepEqual(args.slice(0, 3), ["draft", "-c", "C123"]);
    assert.ok(args.includes("-t"));
    const file = args[args.indexOf("--file") + 1];
    assert.match(
      dirname(file).split("/").pop() ?? "",
      /^draft-[A-Za-z0-9]{6}$/,
    );
    assert.equal(outcome.kind, "saved");
    // 一時フォルダは残らない
    assert.equal(existsSync(dirname(file)), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveDraft: run が reject したら分類して返し、投げない", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-flow-"));
  try {
    const { outcome } = await saveDraft({
      target: { kind: "person", id: "U2" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(outcome.kind, "unconfirmed");
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveDraft: 古い draft- の一時フォルダを消し、送信の一時フォルダ（send-）は消さない", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-flow-"));
  try {
    const oldDraft = await mkdtemp(join(root, DRAFT_DIR_PREFIX));
    const oldSend = await mkdtemp(join(root, SEND_DIR_PREFIX));
    const past = new Date(Date.now() - STALE_SEND_DIR_MS - 60_000);
    await utimes(oldDraft, past, past);
    await utimes(oldSend, past, past);

    await saveDraft({
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run: async () => result({ stdout: '{"draftId":"Dr1","channelId":"C1"}' }),
    });

    assert.equal(existsSync(oldDraft), false);
    assert.equal(existsSync(oldSend), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
