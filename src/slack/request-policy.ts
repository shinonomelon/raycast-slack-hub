import { SlackApiError, type ApiMethod, type ApiOptions } from "./slack-api.ts";
import { t } from "../shared/i18n.ts";
import {
  createMemoryPolicyStore,
  type RequestPolicyStore,
} from "./request-policy-store.ts";
export type RequestPolicy = {
  beforeSend(method: ApiMethod, options: ApiOptions): Promise<number>;
  pause(method: ApiMethod, seconds: number): Promise<number>;
};
export type PolicyConfig = {
  credentialKey: string;
  store?: RequestPolicyStore;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  historyIntervalMs?: number | (() => number);
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new SlackApiError("aborted", t("通信を中断しました")));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
export function createRequestPolicy(config: PolicyConfig): RequestPolicy {
  const now = config.now ?? Date.now,
    store = config.store ?? createMemoryPolicyStore(),
    wait = config.sleep ?? sleep;
  const interval = (method: ApiMethod) => {
    if (
      ["search.messages", "users.list", "conversations.list"].includes(method)
    )
      return 3100;
    if (method === "conversations.members") return 650;
    if (["conversations.history", "conversations.replies"].includes(method))
      return typeof config.historyIntervalMs === "function"
        ? config.historyIntervalMs()
        : (config.historyIntervalMs ?? 60000);
    return 1300;
  };
  return {
    async beforeSend(method, options) {
      const started = now();
      for (;;) {
        const deadline =
          options.deadlineAt ?? started + (options.timeoutMs ?? 30000);
        if (options.signal?.aborted)
          throw new SlackApiError("aborted", t("通信を中断しました"));
        let retryAt = now() + 20,
          paused = false,
          sent = false;
        const committed = store.update(
          config.credentialKey,
          method,
          (state) => {
            paused = state.pausedUntil > now();
            retryAt = Math.max(state.nextStartAt, state.pausedUntil);
            if (retryAt <= now() && now() < deadline) {
              sent = true;
              return {
                updatedAt: now(),
                nextStartAt: now() + interval(method),
                pausedUntil: state.pausedUntil,
              };
            }
            return state;
          },
        );
        if (sent && committed) return now() - started;
        if (!committed) retryAt = now() + 20;
        const seconds = Math.max(0, Math.ceil((retryAt - now()) / 1000));
        if (paused || retryAt >= deadline || now() >= deadline) {
          const error = new SlackApiError(
            paused ? "rate_limited" : "deferred",
            paused
              ? t("Slack APIの回数制限です")
              : t("Slack APIの取得を延期しました"),
            seconds,
          );
          error.retryAt = retryAt;
          throw error;
        }
        await wait(Math.max(1, retryAt - now()), options.signal);
      }
    },
    async pause(method, seconds) {
      const until = now() + seconds * 1000;
      for (;;) {
        const result = store.update(config.credentialKey, method, (state) => ({
          ...state,
          updatedAt: now(),
          pausedUntil: Math.max(state.pausedUntil, until),
        }));
        if (result) return result.pausedUntil;
        await wait(20);
      }
    },
  };
}
