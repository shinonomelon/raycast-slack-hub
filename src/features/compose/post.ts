// 本文はメモリ内で変換し、公式APIへ渡す。一時ファイルも外部プロセスも使わない。
import {
  classifySendError,
  classifySendResponse,
  composeMarkdown,
  SEND_TIMEOUT_MS,
  type SendOutcome,
  type SendTarget,
} from "./compose.ts";
import { toBlocks, toText } from "./md-to-blocks.ts";
import { MessageLimitError, validateMessageBlocks } from "./message-limits.ts";
import { object, SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
export async function postMarkdown(params: {
  target: SendTarget;
  mentionIds: readonly string[];
  markdown: string;
  threadTs?: string;
  teamId: string;
  api: ApiCall;
}): Promise<SendOutcome> {
  const validId =
    params.target.kind === "person"
      ? /^[UW][A-Z0-9]+$/.test(params.target.id)
      : /^[CDG][A-Z0-9]+$/.test(params.target.id);
  if (
    !validId ||
    !params.markdown.trim() ||
    (params.threadTs !== undefined && !/^\d{10}\.\d{6}$/.test(params.threadTs))
  )
    return { kind: "failed", message: "宛先と本文を確認してください" };
  let blocks: ReturnType<typeof toBlocks>;
  let text: string;
  try {
    const markdown = composeMarkdown(params.mentionIds, params.markdown);
    blocks = toBlocks(markdown);
    validateMessageBlocks(blocks);
    text = toText(markdown);
  } catch (error) {
    if (error instanceof MessageLimitError)
      return { kind: "failed", message: error.message };
    return { kind: "failed", message: "本文を変換できませんでした" };
  }
  const started = Date.now();
  let channel = params.target.id;
  if (params.target.kind === "person") {
    try {
      const opened = await params.api(
        "conversations.open",
        { users: channel },
        { timeoutMs: SEND_TIMEOUT_MS },
      );
      const id = object(opened.channel).id;
      if (typeof id !== "string" || !/^D[A-Z0-9]+$/.test(id))
        return {
          kind: "failed",
          message: "DMの会話IDを取得できませんでした。投稿は送信していません",
        };
      channel = id;
    } catch (error) {
      const reason =
        error instanceof SlackApiError
          ? error.message
          : "トークンとim:write権限を確認してください";
      return {
        kind: "failed",
        message: `DMを開けませんでした（${reason}）。投稿は送信していません`,
      };
    }
  }
  try {
    const remaining = SEND_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0)
      return {
        kind: "failed",
        message: "DMの取得が時間切れになりました。投稿は送信していません",
      };
    // 再試行も画面を閉じたことによる中断も行わず、二重投稿を防ぐ。
    const data = await params.api(
      "chat.postMessage",
      {
        channel,
        text,
        blocks,
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      },
      { timeoutMs: remaining },
    );
    return classifySendResponse(params.teamId, data, params.threadTs);
  } catch (error) {
    return classifySendError(error);
  }
}
