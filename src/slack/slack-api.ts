// Slack公式Web APIへの通信。認証情報はヘッダーだけに載せ、応答や通信例外に含まれる秘密を表示しない。
export type ApiMethod =
  | "auth.test"
  | "conversations.list"
  | "conversations.members"
  | "users.list"
  | "users.conversations"
  | "search.messages"
  | "conversations.info"
  | "conversations.open"
  | "chat.postMessage"
  | "chat.getPermalink"
  | "conversations.history"
  | "conversations.replies"
  | "reactions.get"
  | "reactions.add"
  | "reactions.remove"
  | "bookmarks.list"
  | "bookmarks.add"
  | "bookmarks.edit"
  | "bookmarks.remove"
  | "search.files"
  | "slackLists.items.list"
  | "slackLists.items.info"
  | "slackLists.items.create"
  | "slackLists.items.update"
  | "slackLists.items.delete";
export type ApiParams = Record<string, unknown>;
export type ApiOptions = { timeoutMs?: number; signal?: AbortSignal };
export type ApiCall = (
  method: ApiMethod,
  params?: ApiParams,
  options?: ApiOptions,
) => Promise<Record<string, unknown>>;
export type ApiErrorKind =
  | "api"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "network"
  | "http"
  | "unreadable"
  | "configuration";
export class SlackApiError extends Error {
  kind: ApiErrorKind;
  retryAfter?: number;
  code?: string;
  constructor(
    kind: ApiErrorKind,
    message: string,
    retryAfter?: number,
    code?: string,
  ) {
    super(message);
    this.name = "SlackApiError";
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function maskTokens(text: string): string {
  return text.replace(/xox[a-z]*[-.][\w.-]+|xapp-[\w-]+/gi, "xox-***");
}
// APIのエラーコードだけを表示し、応答本文・トークン・投稿内容はログに出さない。
const safeCode = (value: unknown) =>
  typeof value === "string" && /^[a-z_]+$/.test(value)
    ? value
    : "unknown_error";
const POST_METHODS: ReadonlySet<ApiMethod> = new Set([
  "auth.test",
  "conversations.open",
  "chat.postMessage",
  "reactions.add",
  "reactions.remove",
  "bookmarks.list",
  "bookmarks.add",
  "bookmarks.edit",
  "bookmarks.remove",
  "slackLists.items.list",
  "slackLists.items.info",
  "slackLists.items.create",
  "slackLists.items.update",
  "slackLists.items.delete",
]);
export function createSlackApi(
  token: string,
  fetcher: typeof fetch = fetch,
): ApiCall {
  const accessToken = token.trim();
  const pausedUntil = new Map<ApiMethod, number>();
  return async (method, params = {}, options = {}) => {
    if (
      !accessToken.startsWith("xoxp-") &&
      !accessToken.startsWith("xoxe.xoxp-")
    ) {
      throw new SlackApiError(
        "configuration",
        "Slack Access TokenにUser OAuth Token（xoxp-）を設定してください",
      );
    }
    const remaining = (pausedUntil.get(method) ?? 0) - Date.now();
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      throw new SlackApiError(
        "rate_limited",
        `Slack APIの回数制限です。${seconds}秒後に再試行してください`,
        seconds,
        "ratelimited",
      );
    }
    if (options.signal?.aborted)
      throw new SlackApiError("aborted", "通信を中断しました");
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const post = POST_METHODS.has(method);
      const url = new URL(`https://slack.com/api/${method}`);
      if (!post)
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
      // リダイレクト先へ認証ヘッダーを渡さず、送信も自動再試行しない。
      const response = await fetcher(url, {
        method: post ? "POST" : "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(post
            ? { "Content-Type": "application/json; charset=utf-8" }
            : {}),
        },
        ...(post ? { body: JSON.stringify(params) } : {}),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const raw = Number(response.headers.get("Retry-After"));
        const seconds = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 60;
        pausedUntil.set(method, Date.now() + seconds * 1000);
        throw new SlackApiError(
          "rate_limited",
          `Slack APIの回数制限です。${seconds}秒後に再試行してください`,
          seconds,
          "ratelimited",
        );
      }
      if (!response.ok)
        throw new SlackApiError(
          "http",
          `Slack APIのHTTPエラー（${response.status}）`,
        );
      let data: Record<string, unknown>;
      try {
        data = object(await response.json());
      } catch {
        throw new SlackApiError(
          "unreadable",
          "Slack APIの応答を読み取れませんでした",
        );
      }
      if (data.ok === false) {
        const code = safeCode(data.error);
        if (code === "ratelimited") {
          pausedUntil.set(method, Date.now() + 60_000);
          throw new SlackApiError(
            "rate_limited",
            "Slack APIの回数制限です。60秒後に再試行してください",
            60,
            code,
          );
        }
        const needed =
          typeof data.needed === "string" &&
          /^[a-z]+:[a-z_.]+(?:,[a-z]+:[a-z_.]+)*$/.test(data.needed)
            ? `（必要な権限: ${data.needed}）`
            : "";
        throw new SlackApiError(
          "api",
          `Slack API: ${code}${needed}`,
          undefined,
          code,
        );
      }
      if (data.ok !== true)
        throw new SlackApiError(
          "unreadable",
          "Slack APIの応答にokがありません",
        );
      return data;
    } catch (error) {
      if (timedOut)
        throw new SlackApiError(
          "timeout",
          `Slack APIへの通信が${timeoutMs / 1000}秒で時間切れになりました`,
        );
      if (options.signal?.aborted)
        throw new SlackApiError("aborted", "通信を中断しました");
      if (error instanceof SlackApiError) throw error;
      throw new SlackApiError("network", "Slack APIとの通信に失敗しました");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}
