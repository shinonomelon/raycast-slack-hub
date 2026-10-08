// 下書きの保存の一連の流れ（本文の組み立て → 箇条書きのあとの空行 → 一時ファイル → slack-cli の draft → 結果の分類）。
// 下書きは、改造版 slack-cli の draft が Slack MCP の slack_send_message_draft を呼んで作る（2026年10月8日）。
// @raycast/api を読み込まないので、node のテストから動かせる（slack-cli を呼ぶ部分は run で差し替える）
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliErrorText, parseJson, stripAnsi } from "./cli-output.ts";
import { composeMarkdown, isSpawnFailure, type SendTarget } from "./compose.ts";
import { removeStaleTempDirs } from "./post.ts";
import type { Run } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// draft は 60 秒で打ち切る。slack-cli は1回の通信を 15 秒で打ち切るので、ふつうはそれより先に終わる
export const DRAFT_TIMEOUT_MS = 60_000;

// 一時フォルダの名前。mkdtemp が、この前置きのあとに6文字の乱数を足す。
// 送信の一時フォルダ（send-…）とは名前が重ならないので、掃除が互いのフォルダを消さない
export const DRAFT_DIR_PREFIX = "draft-";
const DRAFT_DIR_NAME = /^draft-[A-Za-z0-9]{6}$/;

// slack-cli の draft が、tools/call を送ったあとの通信の失敗・時間切れ・読めない応答のときに、エラー文の先頭に付ける印。
// このときは Slack 側で下書きが作られている可能性があるので、「失敗」でなく「作れたか未確認」にする。
// slack-cli の側（src/utils/slack-mcp-client.ts の MCP_REQUEST_ERROR）と同じ文字列で、両方のテストが確かめる
export const MCP_REQUEST_ERROR = "Slack MCP request error:";

const MAYBE_SAVED =
  "下書きが作られている可能性があります。Slack の Drafts & sent で確かめてください";

export type DraftOutcome =
  // 作れた。Slack が返した draft_id と、下書きのある会話の ID（人宛てなら DM の ID）
  | {
      kind: "saved";
      draftId: string;
      channelId: string;
      threadTs: string | null;
    }
  // 作れたか未確認。時間切れ・通信の失敗など、Slack 側で処理が済んでいるかもしれないとき
  | { kind: "unconfirmed"; message: string }
  // 作れなかった。draft_id が返らなかった・Slack が断った・引数の誤りなど
  | { kind: "failed"; message: string };

// slack-cli の draft を呼ぶ関数。テストで差し替える。
// 結果が得られたら CliResult を返し、起動できなかったときや、起動したあとに失敗したときは reject する
export type DraftRunner = (args: string[]) => Promise<CliResult>;

// 送信と同じく、中断（signal）は渡さない。止めるのは時間切れのときだけ
export const draftRunner =
  (run: Run): DraftRunner =>
  (args) =>
    run(args, { timeoutMs: DRAFT_TIMEOUT_MS });

// ---- 本文 ------------------------------------------------------------------------

// 箇条書きの項目（- * + または 1. 1)）。先頭の空白は3つまで
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
// コードブロックの囲み（``` か ~~~）
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// 箇条書きの項目の直後に、空行でも箇条書きでもない行が来たら、空行を1つ足す。
// Slack の下書きは、空行を挟まないと、その行を最後の項目につなげてしまう（2026年10月8日に実測）。
// 字下げした行は項目の続きとして扱い、そのままにする。コードブロックの中は触らない
export function ensureBlankLineAfterLists(markdown: string): string {
  const out: string[] = [];
  // 開いているコードブロックの囲みの記号。閉じるのは同じ記号で、同じ長さ以上の行
  let fence: string | undefined;
  let afterItem = false;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      out.push(line);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = undefined;
      }
      continue;
    }
    const blank = line.trim() === "";
    const item = LIST_ITEM.test(line);
    // 字下げは半角の空白とタブだけ。全角の空白で始まる行は、Slack では項目の続きにならない
    const indented = /^[ \t]/.test(line);
    if (afterItem && !blank && !item && !indented) out.push("");
    out.push(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      afterItem = false;
      continue;
    }
    afterItem = item || (afterItem && indented && !blank);
  }
  return out.join("\n");
}

// ---- 引数と結果の分類 --------------------------------------------------------------

// slack-cli の draft に渡す引数。本文は複数行になるのでファイルで渡す。
// 人は DM を開く元のユーザー ID（--user-id）で渡す。threadTs があれば、そのスレッドへの返信の下書きにする（-t）
export function buildDraftArgs(params: {
  target: SendTarget;
  file: string;
  threadTs?: string;
}): string[] {
  const { target, file, threadTs } = params;
  return [
    "draft",
    target.kind === "person" ? "--user-id" : "-c",
    target.id,
    "--file",
    file,
    ...(threadTs ? ["-t", threadTs] : []),
    "--format",
    "json",
  ];
}

// 正常終了の標準出力（{"draftId":…,"channelId":…,"threadTs":…}）を読む。形が違えば undefined
function readSaved(
  stdout: string,
): Extract<DraftOutcome, { kind: "saved" }> | undefined {
  let json: unknown;
  try {
    json = parseJson<unknown>(stdout, undefined);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const { draftId, channelId, threadTs } = json as Record<string, unknown>;
  if (typeof draftId !== "string" || draftId === "") return undefined;
  if (typeof channelId !== "string" || channelId === "") return undefined;
  return {
    kind: "saved",
    draftId,
    channelId,
    threadTs: typeof threadTs === "string" ? threadTs : null,
  };
}

// draft を呼んだ結果を「作れた」「作れたか未確認」「作れなかった」に分ける。分け方は送信（classifySendResult）に合わせる。
// - 終了コード 0 で応答が読めれば作れた。0 でも読めなければ、draft_id が分からないので未確認
// - 時間切れ・中断・シグナルで止まったときと、tools/call を送ったあとの通信の失敗（印 MCP_REQUEST_ERROR）は未確認
// - それ以外で 0 以外で終わったとき（draft_id が返らない・Slack が断った・MCP が使えない・引数の誤り）は作れなかった
export function classifyDraftResult(result: CliResult): DraftOutcome {
  if (result.code === 0) {
    return (
      readSaved(result.stdout) ?? {
        kind: "unconfirmed",
        message: `slack-cli は正常に終わりましたが、応答を読み取れませんでした。${MAYBE_SAVED}`,
      }
    );
  }
  if (result.timedOut) {
    return {
      kind: "unconfirmed",
      message: `slack-cli が ${DRAFT_TIMEOUT_MS / 1000} 秒以内に終わらず止めました。${MAYBE_SAVED}`,
    };
  }
  if (result.aborted) {
    return {
      kind: "unconfirmed",
      message: `下書きの保存を中断しました。${MAYBE_SAVED}`,
    };
  }
  if (result.code === null) {
    return {
      kind: "unconfirmed",
      message: `slack-cli が途中で止められました（${result.signal ?? "不明なシグナル"}）。${MAYBE_SAVED}`,
    };
  }
  const stderr = stripAnsi(result.stderr);
  const text = cliErrorText(result);
  if (stderr.includes(MCP_REQUEST_ERROR)) {
    return {
      kind: "unconfirmed",
      message: `通信に失敗しました（${text}）。${MAYBE_SAVED}`,
    };
  }
  // draft を持たない slack-cli（本家・古い改造版）は、存在しないコマンドとして失敗する
  if (stderr.includes("unknown command 'draft'")) {
    return {
      kind: "failed",
      message:
        "使っている slack-cli に draft コマンドがありません。改造版 slack-cli を新しくしてください",
    };
  }
  return { kind: "failed", message: text };
}

// draft を呼ぶ関数が、結果を返さずに reject したときの分類。
// 起動できなかったときだけ、Slack には何も送っていないので「作れなかった」。それ以外は未確認
export function classifyDraftRunError(error: unknown): DraftOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (isSpawnFailure(error)) return { kind: "failed", message };
  return {
    kind: "unconfirmed",
    message: `slack-cli の実行が途中で失敗しました（${message}）。${MAYBE_SAVED}`,
  };
}

// ---- 保存の流れ ------------------------------------------------------------------

// 本文にメンションを付け、箇条書きのあとに空行を補い、一時ファイル経由で draft に渡して、結果を分類して返す。投げない。
// 返す markdown は Slack に渡した本文そのもの（控えに残す）。
// 一時ファイルは、結果に関わらず保存のあとに消す（本文が残らないように）
export async function saveDraft(params: {
  target: SendTarget;
  mentionIds: readonly string[];
  markdown: string;
  // 一時ファイルを置くフォルダ（無ければ作る）
  tmpRoot: string;
  // スレッドへの返信の下書きのとき、スレッドの親の ts
  threadTs?: string;
  // slack-cli の draft を呼ぶ関数。Raycast の設定を読む側が渡す（このファイルは Raycast を読み込まない）
  run: DraftRunner;
}): Promise<{ outcome: DraftOutcome; markdown: string }> {
  const markdown = ensureBlankLineAfterLists(
    composeMarkdown(params.mentionIds, params.markdown),
  );
  let dir: string | undefined;
  try {
    await mkdir(params.tmpRoot, { recursive: true });
    await removeStaleTempDirs(params.tmpRoot, DRAFT_DIR_NAME);
    dir = await mkdtemp(join(params.tmpRoot, DRAFT_DIR_PREFIX));
    const file = join(dir, "message.md");
    await writeFile(file, markdown);
    let result: CliResult;
    try {
      result = await params.run(
        buildDraftArgs({
          target: params.target,
          file,
          threadTs: params.threadTs,
        }),
      );
    } catch (error) {
      return { outcome: classifyDraftRunError(error), markdown };
    }
    return { outcome: classifyDraftResult(result), markdown };
  } catch (error) {
    // 一時ファイルを作れなかったなど、slack-cli を呼ぶ前に終わった失敗
    return {
      outcome: {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
      markdown,
    };
  } finally {
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
