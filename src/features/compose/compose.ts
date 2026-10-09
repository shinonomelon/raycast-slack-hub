// 投稿まわりの純粋な部品（本文の前置き・slack:// のリンク・送信の引数・送信結果の分類）。
// @raycast/api を読み込まないので、node のテストから動かせる
import { isThreadReply, messageLink, type Hit } from "../../slack/hits.ts";
import type { Item } from "../search/search.ts";
import { SlackApiError, maskTokens } from "../../slack/slack-api.ts";

// 投稿は60秒で打ち切る。時間切れは「失敗」でなく「送れたか未確認」として扱う（下の classifySendError）
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
// リンクのワークスペースの ID（teamId）は、auth.test で取った値を、呼び出し側が渡す

export function slackAppChannelLink(teamId: string, channelId: string): string {
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

export function slackAppUserLink(teamId: string, userId: string): string {
  return `slack://user?team=${teamId}&id=${userId}`;
}

// ブラウザを通らずに投稿の位置まで移動する。
// message= は公式ドキュメントに無いが、この Mac で投稿まで移動することを確かめた（2026年10月4日）。
// スレッドへの返信は、スレッドの親の ts（threadTs）も付けると、スレッドの中のその返信が開く。
// 一覧のメッセージの行の Open in Slack（↵。hits.ts の messageLink）と同じリンクにそろえるため、組み立ては messageLink に任せる
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
// - 返信：スレッドの親の位置を開く。threadTsはAPIへ渡した親の値（返信の行ならその親、最上位の投稿ならその投稿自身）。
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

export type UnconfirmedReason =
  "timeout" | "aborted" | "request_error" | "http_error" | "unreadable";

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

// 成功応答に投稿位置が含まれる場合だけ、送信済みとする。
export function classifySendResponse(
  teamId: string,
  data: Record<string, unknown>,
  threadTs?: string,
): SendOutcome {
  if (
    data.ok !== true ||
    typeof data.channel !== "string" ||
    !/^[CDG][A-Z0-9]+$/.test(data.channel) ||
    typeof data.ts !== "string" ||
    !/^\d{10}\.\d{6}$/.test(data.ts)
  ) {
    return {
      kind: "unconfirmed",
      reason: "unreadable",
      message:
        "投稿の応答を読み取れませんでした。Slackには届いている可能性があります",
    };
  }
  return {
    kind: "sent",
    channelId: data.channel,
    ts: data.ts,
    threadTs: threadTs ?? null,
    link: slackAppMessageLink(teamId, data.channel, data.ts, threadTs),
  };
}
// Slackが断った場合だけ失敗。通信・HTTP・時間切れでは投稿済みの可能性を残す。
export function classifySendError(error: unknown): SendOutcome {
  if (
    error instanceof SlackApiError &&
    ["configuration", "rate_limited"].includes(error.kind)
  )
    return { kind: "failed", message: error.message };
  if (
    error instanceof SlackApiError &&
    error.kind === "api" &&
    ![
      "internal_error",
      "fatal_error",
      "request_timeout",
      "service_unavailable",
    ].includes(error.code ?? "")
  )
    return { kind: "failed", message: error.message };
  const reason: UnconfirmedReason =
    error instanceof SlackApiError && error.kind === "timeout"
      ? "timeout"
      : error instanceof SlackApiError && error.kind === "http"
        ? "http_error"
        : error instanceof SlackApiError && error.kind === "unreadable"
          ? "unreadable"
          : "request_error";
  const message =
    error instanceof SlackApiError
      ? error.message
      : "Slack APIとの通信に失敗しました";
  return {
    kind: "unconfirmed",
    reason,
    message: `${maskTokens(message)}。Slackには届いている可能性があります。送信先を確認してください`,
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
