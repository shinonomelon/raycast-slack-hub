import { createHash } from "node:crypto";
import type { RequestPolicy } from "./request-policy.ts";
import type { RequestMetrics } from "./request-metrics.ts";
import { setApiContext } from "./request-context.ts";
import { t } from "../shared/i18n.ts";
// Slack公式Web APIへの通信。認証情報はヘッダーだけに載せ、応答や通信例外に含まれる秘密を表示しない。
export type ApiMethod =
  | "auth.test"
  | "conversations.list"
  | "conversations.members"
  | "users.list"
  | "users.conversations"
  | "search.messages"
  | "conversations.history"
  | "conversations.replies"
  | "conversations.info"
  | "conversations.open"
  | "chat.postMessage";
export type ApiParams = Record<string, unknown>;
export type ApiSource =
  | "background"
  | "directory"
  | "search"
  | "triage"
  | "reply-priority"
  | "membership"
  | "thread-context"
  | "reply-check"
  | "post"
  | "auth"
  | "unknown";
export type ApiOptions = {
  deadlineAt?: number;
  source?: ApiSource;
  dedupe?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type ApiCall = (
  method: ApiMethod,
  params?: ApiParams,
  options?: ApiOptions,
) => Promise<Record<string, unknown>>;
export type ApiErrorKind =
  | "deferred"
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
  retryAt?: number;
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
]);
export function createSlackApi(
  token: string,
  fetcher: typeof fetch = fetch,
  config: {
    policy?: RequestPolicy;
    metrics?: RequestMetrics;
    now?: () => number;
  } = {},
): ApiCall {
  const now = config.now ?? Date.now;
  const accessToken = token.trim();
  const pausedUntil = new Map<ApiMethod, number>();
  const sentCallbacks = new WeakMap<ApiOptions, () => void>();
  const execute: ApiCall = async (method, params = {}, options = {}) => {
    if (
      !accessToken.startsWith("xoxp-") &&
      !accessToken.startsWith("xoxe.xoxp-")
    ) {
      throw new SlackApiError(
        "configuration",
        t("Slack Access TokenにUser OAuth Token（xoxp-）を設定してください"),
      );
    }
    const remaining = (pausedUntil.get(method) ?? 0) - now();
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      throw new SlackApiError(
        "rate_limited",
        t("Slack APIの回数制限です。{0}秒後に再試行してください", seconds),
        seconds,
        "ratelimited",
      );
    }
    if (options.signal?.aborted)
      throw new SlackApiError("aborted", t("通信を中断しました"));
    const waitMs = config.policy
      ? await config.policy.beforeSend(method, options)
      : 0;
    if (options.signal?.aborted)
      throw new SlackApiError("aborted", t("通信を中断しました"));
    config.metrics?.record(
      options.source ?? "unknown",
      method,
      "waitMs",
      waitMs,
    );
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      if (controller.signal.aborted)
        throw new SlackApiError("aborted", t("通信を中断しました"));
      const post = POST_METHODS.has(method);
      const url = new URL(`https://slack.com/api/${method}`);
      if (!post)
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
      // リダイレクト先へ認証ヘッダーを渡さず、送信も自動再試行しない。
      const init: RequestInit = {
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
      };
      if (options.signal?.aborted || controller.signal.aborted)
        throw new SlackApiError("aborted", t("通信を中断しました"));
      sentCallbacks.get(options)?.();
      const responsePromise = fetcher(url, init);
      config.metrics?.record(options.source ?? "unknown", method, "requests");
      const response = await responsePromise;
      if (response.status === 429) {
        const raw = Number(response.headers.get("Retry-After"));
        const seconds = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 60;
        pausedUntil.set(method, now() + seconds * 1000);
        await config.policy?.pause(method, seconds);
        config.metrics?.record(
          options.source ?? "unknown",
          method,
          "rateLimited",
        );
        throw new SlackApiError(
          "rate_limited",
          t("Slack APIの回数制限です。{0}秒後に再試行してください", seconds),
          seconds,
          "ratelimited",
        );
      }
      if (!response.ok)
        throw new SlackApiError(
          "http",
          t("Slack APIのHTTPエラー（{0}）", response.status),
        );
      let data: Record<string, unknown>;
      try {
        data = object(await response.json());
      } catch {
        throw new SlackApiError(
          "unreadable",
          t("Slack APIの応答を読み取れませんでした"),
        );
      }
      if (data.ok === false) {
        const code = safeCode(data.error);
        if (code === "ratelimited") {
          pausedUntil.set(method, now() + 60000);
          await config.policy?.pause(method, 60);
          config.metrics?.record(
            options.source ?? "unknown",
            method,
            "rateLimited",
          );
          throw new SlackApiError(
            "rate_limited",
            t("Slack APIの回数制限です。60秒後に再試行してください"),
            60,
            code,
          );
        }
        const needed =
          typeof data.needed === "string" &&
          /^[a-z]+:[a-z_.]+(?:,[a-z]+:[a-z_.]+)*$/.test(data.needed)
            ? t("（必要な権限: {0}）", data.needed)
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
          t("Slack APIの応答にokがありません"),
        );
      return data;
    } catch (error) {
      if (timedOut)
        throw new SlackApiError(
          "timeout",
          t("Slack APIへの通信が{0}秒で時間切れになりました", timeoutMs / 1000),
        );
      if (options.signal?.aborted)
        throw new SlackApiError("aborted", t("通信を中断しました"));
      if (error instanceof SlackApiError) throw error;
      throw new SlackApiError("network", t("Slack APIとの通信に失敗しました"));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  const flights = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<Record<string, unknown>>;
      subscribers: number;
      deadlineAt: number;
      started: boolean;
    }
  >();
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  const api: ApiCall = (method, params = {}, options = {}) => {
    if (options.signal?.aborted)
      return Promise.reject(
        new SlackApiError("aborted", t("通信を中断しました")),
      );
    if (
      options.dedupe === false ||
      method === "chat.postMessage" ||
      method === "conversations.open"
    )
      return execute(method, params, options);
    const key = `${method}:${canonical(params)}:${options.timeoutMs ?? 30000}`;
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      // 操作期限は購読者ごとに扱い、共有通信を先に中断しない。
      const sharedOptions = {
        ...options,
        signal: controller.signal,
        get deadlineAt() {
          return (
            flights.get(key)?.deadlineAt ??
            options.deadlineAt ??
            now() + (options.timeoutMs ?? 30000)
          );
        },
      };
      const promise = Promise.resolve().then(() =>
        execute(method, params, sharedOptions),
      );
      flight = {
        controller,
        promise,
        subscribers: 0,
        started: false,
        deadlineAt: options.deadlineAt ?? now() + (options.timeoutMs ?? 30000),
      };
      flights.set(key, flight);
      sentCallbacks.set(sharedOptions, () => {
        if (flight) flight.started = true;
      });
      const current = flight;
      void promise
        .finally(() => {
          if (flights.get(key) === current) flights.delete(key);
        })
        .catch(() => {});
    }
    const current = flight;
    if (current.subscribers > 0)
      config.metrics?.record(options.source ?? "unknown", method, "coalesced");
    current.subscribers++;
    current.deadlineAt = Math.max(
      current.deadlineAt,
      options.deadlineAt ?? now() + (options.timeoutMs ?? 30000),
    );
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, data?: Record<string, unknown>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (--current.subscribers === 0) {
          current.controller.abort();
          if (flights.get(key) === current) flights.delete(key);
        }
        if (error) reject(error);
        else resolve(data!);
      };
      const abort = () =>
        finish(new SlackApiError("aborted", t("通信を中断しました")));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      if (options.deadlineAt !== undefined)
        timer = setTimeout(
          () => {
            const error = new SlackApiError(
              current.started ? "timeout" : "deferred",
              current.started
                ? t("Slack APIへの通信が時間切れになりました")
                : t("Slack APIの取得を延期しました"),
              0,
            );
            error.retryAt = now();
            finish(error);
          },
          Math.max(0, options.deadlineAt - now()),
        );
      current.promise.then(
        (data) => finish(undefined, data),
        (error) => finish(error),
      );
    });
  };
  setApiContext(
    api,
    createHash("sha256").update(accessToken).digest("hex"),
    config.metrics,
  );
  return api;
}
