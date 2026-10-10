import {
  object,
  SlackApiError,
  type ApiCall,
  type ApiMethod,
  type ApiParams,
} from "../../slack/slack-api.ts";

export type WriteOutcome =
  | { kind: "succeeded"; id?: string }
  | { kind: "failed" | "unconfirmed"; message: string };

// 明確な拒否以外は、部分的に変更された可能性を残す。
const DEFINITE_REJECTIONS = new Set([
  "missing_scope",
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "no_permission",
  "permission_denied",
  "restricted_action",
  "access_denied",
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_array_arg",
  "invalid_name",
  "invalid_emoji",
  "channel_not_found",
  "not_in_channel",
  "not_found",
  "invalid_list_id",
  "list_not_found",
  "invalid_record_id",
  "record_not_found",
  "invalid_column_id",
  "invalid_ts",
  "message_not_found",
  "is_archived",
  "too_many_bookmarks",
  "invalid_bookmark_id",
  "invalid_type",
  "invalid_link",
  "invalid_title",
]);

export function writeOutcomeError(error: unknown): WriteOutcome {
  if (error instanceof SlackApiError) {
    const failed =
      error.kind === "configuration" ||
      error.kind === "rate_limited" ||
      (error.kind === "api" && DEFINITE_REJECTIONS.has(error.code ?? ""));
    return { kind: failed ? "failed" : "unconfirmed", message: error.message };
  }
  return {
    kind: "unconfirmed",
    message:
      "変更結果を確認できませんでした。Slackで確認し、二重作成に注意してください。",
  };
}

export async function runWrite(
  api: ApiCall,
  method: ApiMethod,
  params: ApiParams,
  validate: (data: Record<string, unknown>) => boolean = (data) =>
    data.ok === true,
): Promise<WriteOutcome> {
  try {
    const data = await api(method, params);
    if (data.ok !== true || !validate(data))
      return {
        kind: "unconfirmed",
        message:
          "変更結果の応答を確認できませんでした。Slackで確認してください。",
      };
    const id =
      object(data.record).id ??
      object(data.bookmark).id ??
      object(data.item).id ??
      data.id;
    return { kind: "succeeded", ...(typeof id === "string" ? { id } : {}) };
  } catch (error) {
    return writeOutcomeError(error);
  }
}

// 状態更新が次の描画まで遅れる場合も、同時送信を1回に限定する。
export function createWriteLock() {
  let busy = false;
  let unconfirmed = false;
  return {
    get busy() {
      return busy;
    },
    get unconfirmed() {
      return unconfirmed;
    },
    async run(
      action: () => Promise<WriteOutcome>,
    ): Promise<WriteOutcome | undefined> {
      if (busy || unconfirmed) return undefined;
      busy = true;
      try {
        let outcome: WriteOutcome;
        try {
          outcome = await action();
        } catch (error) {
          outcome = writeOutcomeError(error);
        }
        if (outcome.kind === "unconfirmed") unconfirmed = true;
        return outcome;
      } finally {
        busy = false;
      }
    },
  };
}
