// 投稿の一連の流れ（本文の組み立て → blocks 変換 → 一時ファイル → send → 結果の分類）。
// @raycast/api を読み込まないので、node のテストから動かせる（slack-cli を呼ぶ部分は run で差し替える）
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSendArgs,
  classifyRunError,
  classifySendResult,
  composeMarkdown,
  SEND_TIMEOUT_MS,
  type SendOutcome,
  type SendTarget,
} from "./compose.ts";
import { toBlocks, toText } from "./md-to-blocks.ts";
import type { Run } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// slack-cli の send を呼ぶ関数。テストで差し替える。
// 結果が得られたら CliResult を返し、起動できなかったときや、起動したあとに失敗したときは reject する
export type SendRunner = (args: string[]) => Promise<CliResult>;

// slack-cli を呼ぶ関数（run）から、送信用の呼び出しを作る。
// 送信には中断（signal）を渡さない。送信中にフォームを閉じても最後まで行い、
// 途中で止めて、届いたかどうか分からない投稿を増やさないため。止めるのは60秒の時間切れのときだけ
export const sendRunner =
  (run: Run): SendRunner =>
  (args) =>
    run(args, { timeoutMs: SEND_TIMEOUT_MS });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// 一時フォルダの名前。mkdtemp が、この前置きのあとに6文字の乱数を足す。
// 掃除の照合（SEND_DIR_NAME）が、送信が作るフォルダの名前に合うことを、テストが同じ前置きで確かめる
export const SEND_DIR_PREFIX = "send-";
const SEND_DIR_NAME = /^send-[A-Za-z0-9]{6}$/;
// これより古い一時フォルダは、送信中のものではない（送信は60秒で打ち切る）
export const STALE_SEND_DIR_MS = 10 * 60_000;

// 送信の途中でコマンドが止められると、本文の入った一時フォルダが残る。送信の前に、古いものを消す。
// 前置きと乱数の名前（name に合うもの）のフォルダだけを対象にし、消せなくても送信は止めない。
// 下書きの保存（draft.ts）も、自分の前置きの名前を渡して同じ規則で掃除する
export async function removeStaleTempDirs(
  tmpRoot: string,
  name: RegExp,
): Promise<void> {
  try {
    const now = Date.now();
    const entries = await readdir(tmpRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && name.test(entry.name))
        .map(async (entry) => {
          const path = join(tmpRoot, entry.name);
          try {
            const { mtimeMs } = await stat(path);
            if (now - mtimeMs > STALE_SEND_DIR_MS) {
              await rm(path, { recursive: true, force: true });
            }
          } catch {
            // ほかの送信が先に消した・消せないなど。この送信には関係しない
          }
        }),
    );
  } catch {
    // 読めなくても、送信は止めない
  }
}

// 本文を blocks と通知用の文字に変え、一時ファイル経由で send に渡し、結果を分類して返す。投げない。
// 複数行の本文をコマンド引数に載せないよう、どちらも一時ファイルで渡す。
// 一時ファイルは、結果に関わらず送信のあとに消す（本文が残らないように）
export async function postMarkdown(params: {
  target: SendTarget;
  mentionIds: readonly string[];
  markdown: string;
  // 一時ファイルを置くフォルダ（無ければ作る）
  tmpRoot: string;
  // スレッドへの返信のとき、スレッドの親の ts
  threadTs?: string;
  // 投稿の位置を開くリンクのワークスペースの ID（whoami で取った値）
  teamId: string;
  // slack-cli の send を呼ぶ関数。Raycast の設定を読む側が渡す（このファイルは Raycast を読み込まない）
  run: SendRunner;
}): Promise<SendOutcome> {
  const { run } = params;
  const md = composeMarkdown(params.mentionIds, params.markdown);
  let dir: string | undefined;
  try {
    await mkdir(params.tmpRoot, { recursive: true });
    await removeStaleTempDirs(params.tmpRoot, SEND_DIR_NAME);
    dir = await mkdtemp(join(params.tmpRoot, SEND_DIR_PREFIX));
    const blocksFile = join(dir, "blocks.json");
    const textFile = join(dir, "text.txt");
    await writeFile(blocksFile, JSON.stringify(toBlocks(md)));
    await writeFile(textFile, toText(md));
    let result: CliResult;
    try {
      result = await run(
        buildSendArgs({
          target: params.target,
          blocksFile,
          textFile,
          threadTs: params.threadTs,
        }),
      );
    } catch (error) {
      // 結果を得られなかった。起動できなかったときだけ失敗で、それ以外は届いている可能性がある
      return classifyRunError(error);
    }
    return classifySendResult(params.teamId, result);
  } catch (error) {
    // 一時ファイルを作れなかったなど、slack-cli を呼ぶ前に終わった失敗
    return { kind: "failed", message: errorMessage(error) };
  } finally {
    // 後始末の失敗で、送信の結果を失わない（届いた投稿を失敗と出すと、送り直しで二重に投稿される）
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
