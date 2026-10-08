// 投稿まわりの純粋な部品（本文の前置き・slack:// のリンク・送信の引数・送信結果の分類）。
// @raycast/api を読み込まないので、node のテストから動かせる
import { cliErrorText, parseJson, stripAnsi } from "./cli-output.ts";
import { isThreadReply, messageLink, type Hit } from "./hits.ts";
import type { Item } from "./search.ts";
import type { CliResult } from "./types.ts";

// send は 60 秒で打ち切る。時間切れは「失敗」でなく「送れたか未確認」として扱う（下の classifySendResult）
export const SEND_TIMEOUT_MS = 60_000;

// メンションがあれば「メンション → 空行 → 本文」、なければ本文だけの Markdown にする
export function composeMarkdown(
  mentionIds: readonly string[],
  body: string,
): string {
  const mentions = mentionIds.map((id) => `<@${id}>`).join(" ");
  return mentions ? `${mentions}\n\n${body}` : body;
}

// ---- Slack アプリを直接開くリンク -------------------------------------------------
// リンクのワークスペースの ID（teamId）は、whoami で取った値を、呼び出し側が渡す

export function slackAppChannelLink(teamId: string, channelId: string): string {
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

export function slackAppUserLink(teamId: string, userId: string): string {
  return `slack://user?team=${teamId}&id=${userId}`;
}

// ブラウザを通らずに投稿の位置まで移動する。
// message= は公式ドキュメントに無いが、この Mac で投稿まで移動することを確かめた（2026年10月4日）。
// スレッドへの返信は、スレッドの親の ts（threadTs）も付けると、スレッドの中のその返信が開く。
// 一覧のメッセージの行の Open in Slack（⌘↵。hits.ts の messageLink）と同じリンクにそろえるため、組み立ては messageLink に任せる
export function slackAppMessageLink(
  teamId: string,
  channelId: string,
  ts: string,
  threadTs?: string,
): string {
  return messageLink(teamId, { channelId, ts, threadTs });
}

// ---- 送信の引数 ------------------------------------------------------------------

// 送り先。会話は会話 ID（C…・G…・D…）で送り、人は DM を開く元のユーザー ID（U…）で送る
export type SendTarget =
  { kind: "conversation"; id: string } | { kind: "person"; id: string };

// 一覧の行から送り先を決める。人の行は DM、それ以外は会話
export function sendTargetOf(item: Pick<Item, "id" | "kind">): SendTarget {
  return item.kind === "person"
    ? { kind: "person", id: item.id }
    : { kind: "conversation", id: item.id };
}

// 送り先の会話・人を Slack アプリで開くリンク。一覧の ↵ と、返信でない送信が未確認のときに開く先（confirmationOf）で使う。
// 人は DM の会話 ID を持っていないので、ユーザーのリンクで開く
export function targetLink(teamId: string, target: SendTarget): string {
  return target.kind === "person"
    ? slackAppUserLink(teamId, target.id)
    : slackAppChannelLink(teamId, target.id);
}

// フォームに出す宛先の表示。チャンネルは #名前、人は @名前、グループDM は参加者の名前を並べた名前
export function destinationLabel(item: Pick<Item, "kind" | "title">): string {
  switch (item.kind) {
    case "person":
      return `@${item.title}`;
    case "group":
      return `${item.title}（グループDM）`;
    case "channel":
    case "private":
      return `#${item.title}`;
  }
}

// スレッドへの返信の送り先。送り先はそのメッセージのある会話で、threadTs はスレッドの親の ts
export type ReplyTarget = { target: SendTarget; threadTs: string };

// メッセージの行から、スレッドへの返信の送り先を決める。
// スレッドの親は、返信ならその親（thread_ts）、スレッドになっていない投稿ならその投稿自身（返信するとそこからスレッドが始まる）
export function replyTargetOf(
  hit: Pick<Hit, "channelId" | "ts" | "threadTs">,
): ReplyTarget {
  return {
    target: { kind: "conversation", id: hit.channelId },
    threadTs: hit.threadTs ?? hit.ts,
  };
}

// 返信のフォームで、親メッセージの欄に付ける見出し。
// 検索結果には親の本文が無いので、スレッド内の返信の行（threadTs があり、ts と違う）から開くと、
// 欄に出るのは選んだ返信そのもの。「返信先」だと親の本文と読み違えるので、「スレッド内の返信」にする。
// 親の行（threadTs が無い、または ts と同じ）は、欄に出るのが親そのものなので「返信先」
export function replyParentTitle(hit: Pick<Hit, "ts" | "threadTs">): string {
  return isThreadReply(hit) ? "スレッド内の返信" : "返信先";
}

// 返信のフォームに出す、親メッセージの説明（送信者・時刻・本文の先頭）。
// body は、呼び出し側で Slack の書式を読める形にして、短くしたもの
export function replyParentText(parent: {
  sender: string;
  time: string;
  body: string;
}): string {
  return `${parent.sender} · ${parent.time}\n${parent.body || "（本文なし）"}`;
}

// 送れたか未確認のときに、届いたかを確かめるために開く先と、その操作の名前・送り直しの確認文。
// - 返信：スレッドの親の位置を開く。threadTs は -t に渡した値（返信の行ならその親、最上位の投稿ならその投稿自身）。
//   スレッドへの返信はチャンネルの流れに出ないので、チャンネルを開いても届いたか確かめられない。
//   リンクは message=<親の ts> だけにし、thread_ts は付けない。この形でチャンネルの中のその位置が開くことは確かめた
//   （2026年10月4日）が、親の ts を thread_ts に付けた形は確かめていない。スレッドの欄まで開くかは実機で見る
// - 返信でない送信：宛先の会話・人を開く
export type Confirmation = {
  // 確かめるために開く先
  link: string;
  // 開く操作の名前
  openTitle: string;
  // 送り直しの確認文
  resendMessage: string;
};

export function confirmationOf(
  teamId: string,
  target: SendTarget,
  threadTs?: string,
): Confirmation {
  // 人宛て（DM を開く元のユーザー ID）には会話 ID が無く、親の位置のリンクを作れない。
  // 返信は会話 ID で送るので、人宛ての返信は起きない
  if (threadTs !== undefined && target.kind === "conversation") {
    return {
      link: slackAppMessageLink(teamId, target.id, threadTs),
      openTitle: "Open Parent Message",
      resendMessage:
        "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ返信が二重になります。先にスレッドの親を開いて、返信が付いたか確かめてください。",
    };
  }
  return {
    link: targetLink(teamId, target),
    openTitle: "Open Conversation",
    resendMessage:
      "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ投稿が二重になります。先に宛先の会話を開いて、確かめてください。",
  };
}

// slack-cli の send に渡す引数。本文は複数行になるので、blocks と通知用の文字はどちらもファイルで渡す。
// --format json で、Slack が返した channelId と ts を受け取る（投稿後に履歴を読み直さないため）。
// threadTs があれば、そのスレッドへの返信として送る（-t）
export function buildSendArgs(params: {
  target: SendTarget;
  blocksFile: string;
  textFile: string;
  threadTs?: string;
}): string[] {
  const { target, blocksFile, textFile, threadTs } = params;
  return [
    "send",
    target.kind === "person" ? "--user-id" : "-c",
    target.id,
    "--blocks-file",
    blocksFile,
    "-f",
    textFile,
    ...(threadTs ? ["-t", threadTs] : []),
    "--format",
    "json",
  ];
}

// ---- 送信結果の分類 --------------------------------------------------------------

// Slack に届いたかどうかが分からない理由
export type UnconfirmedReason =
  | "timeout"
  | "aborted"
  | "killed"
  | "request_error"
  | "http_error"
  | "unreadable"
  // slack-cli を起動したあとに、呼び出しの側が失敗した（出力が上限を超えたなど）
  | "process_error";

export type SendOutcome =
  // 届いた。Slack が返した channelId・ts と、投稿の位置を開くリンク
  | {
      kind: "sent";
      channelId: string;
      ts: string;
      threadTs: string | null;
      link: string;
    }
  // 送れたか未確認。chat.postMessage は Slack に届いた時点で成立し、手元で止めても取り消されない。
  // 「失敗」と出すと送り直しで二重に投稿されうるので、送り直しは勧めない
  | { kind: "unconfirmed"; reason: UnconfirmedReason; message: string }
  // Slack が断った・引数の誤りなど、送る前に終わった失敗
  | { kind: "failed"; message: string };

const REQUEST_ERROR = "A request error occurred:";
const HTTP_ERROR = "An HTTP protocol error occurred:";
const TS_PATTERN = /^\d{10}\.\d{6}$/;
const MAYBE_DELIVERED = "Slack には届いている可能性があります";

// 正常終了の標準出力（{"ok":true,"channelId":…,"ts":…,"threadTs":…}）を読む。形が違えば undefined
function readSent(
  teamId: string,
  stdout: string,
): Extract<SendOutcome, { kind: "sent" }> | undefined {
  let json: unknown;
  try {
    json = parseJson<unknown>(stdout, undefined);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const { ok, channelId, ts, threadTs } = json as Record<string, unknown>;
  if (ok !== true || typeof channelId !== "string" || channelId === "") {
    return undefined;
  }
  if (typeof ts !== "string" || !TS_PATTERN.test(ts)) return undefined;
  return {
    kind: "sent",
    channelId,
    ts,
    threadTs: typeof threadTs === "string" ? threadTs : null,
    // スレッドへの返信は、スレッドの中の返信の位置を開く
    link: slackAppMessageLink(
      teamId,
      channelId,
      ts,
      typeof threadTs === "string" ? threadTs : undefined,
    ),
  };
}

// send を呼んだ結果を「届いた」「送れたか未確認」「失敗」に分ける。
// - 終了コード 0 で応答が読めれば届いた。0 でも応答が読めなければ、位置が分からないので未確認にする
// - 時間切れ・中断・シグナルで止まったときと、通信・HTTP の失敗（届いたあとに応答だけが失われた場合がある）は未確認
// - それ以外で 0 以外で終わったとき（Slack が断った API エラー・回数制限・引数の誤り）は失敗
export function classifySendResult(
  teamId: string,
  result: CliResult,
): SendOutcome {
  if (result.code === 0) {
    return (
      readSent(teamId, result.stdout) ?? {
        kind: "unconfirmed",
        reason: "unreadable",
        message: `slack-cli は正常に終わりましたが、応答を読み取れませんでした。${MAYBE_DELIVERED}`,
      }
    );
  }
  if (result.timedOut) {
    return {
      kind: "unconfirmed",
      reason: "timeout",
      message: `slack-cli が ${SEND_TIMEOUT_MS / 1000} 秒以内に終わらず止めました。止めた時点で Slack に届いていた可能性があります`,
    };
  }
  if (result.aborted) {
    return {
      kind: "unconfirmed",
      reason: "aborted",
      message:
        "送信を中断しました。中断した時点で Slack に届いていた可能性があります",
    };
  }
  if (result.code === null) {
    return {
      kind: "unconfirmed",
      reason: "killed",
      message: `slack-cli が途中で止められました（${result.signal ?? "不明なシグナル"}）。${MAYBE_DELIVERED}`,
    };
  }
  const stderr = stripAnsi(result.stderr);
  const text = cliErrorText(result);
  if (stderr.includes(REQUEST_ERROR)) {
    return {
      kind: "unconfirmed",
      reason: "request_error",
      message: `通信に失敗しました（${text}）。${MAYBE_DELIVERED}`,
    };
  }
  if (stderr.includes(HTTP_ERROR)) {
    return {
      kind: "unconfirmed",
      reason: "http_error",
      message: `Slack からの応答が正しくありませんでした（${text}）。${MAYBE_DELIVERED}`,
    };
  }
  return { kind: "failed", message: text };
}

// プロセスを起動できなかったときに Node が返すエラー（ENOENT・EACCES など）。
// code と、"spawn <コマンド>" で始まる syscall を持つ。下書きの結果の分類（draft.ts）も使う
export function isSpawnFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as NodeJS.ErrnoException;
  return (
    typeof code === "string" &&
    typeof syscall === "string" &&
    syscall.startsWith("spawn")
  );
}

// send を呼ぶ関数が、結果を返さずに reject したときの分類。
// 起動できなかったときだけ、Slack には何も送っていないので「失敗」。
// それ以外は、起動したあとの失敗（出力が上限を超えたなど）かもしれず、Slack に届いている可能性があるので、
// 送り直しで二重に投稿されないよう「未確認」にする
export function classifyRunError(error: unknown): SendOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (isSpawnFailure(error)) return { kind: "failed", message };
  return {
    kind: "unconfirmed",
    reason: "process_error",
    message: `slack-cli の実行が途中で失敗しました（${message}）。${MAYBE_DELIVERED}`,
  };
}

// ---- 送信のあとの印 --------------------------------------------------------------

// 返信が届いたときだけ、元のメッセージの行に「開いた」の印を付ける（行を開いたのと同じに、読んだものとして扱う）。
// 送れたか未確認のとき（届いていないかもしれない）と、失敗したときは付けない。
// 返信でない投稿（会話の行・人の行から書いた）にも付けない（印を付ける行が無い）
export function shouldMarkReplied(
  outcome: SendOutcome,
  isReply: boolean,
): boolean {
  return isReply && outcome.kind === "sent";
}
