// 同じ認証・保存先の画面はAPIクライアントを共有する。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createSlackApi, type ApiCall } from "./slack-api.ts";
import { createRequestPolicy } from "./request-policy.ts";
import { createRequestPolicyStore } from "./request-policy-store.ts";
import { createRequestMetrics } from "./request-metrics.ts";
export type ApiRuntime = {
  supportPath: string;
  preferences: () => Record<string, unknown>;
};
const clients = new Map<string, ApiCall>();
export function apiForToken(token: string, runtime?: ApiRuntime): ApiCall {
  const credentialKey = createHash("sha256").update(token.trim()).digest("hex");
  const key = `${runtime?.supportPath ?? "memory"}:${credentialKey}`;
  let api = clients.get(key);
  if (!api) {
    const policy = createRequestPolicy({
      credentialKey,
      ...(runtime
        ? {
            store: createRequestPolicyStore(
              join(runtime.supportPath, "request-policy"),
            ),
            historyIntervalMs: () =>
              runtime.preferences().slackApiDistribution === "verified-internal"
                ? 1300
                : 60000,
          }
        : {}),
    });
    api = createSlackApi(token, fetch, {
      policy,
      ...(runtime
        ? {
            metrics: createRequestMetrics(
              join(runtime.supportPath, "request-metrics.json"),
            ),
          }
        : {}),
    });
    clients.set(key, api);
    if (clients.size > 4) clients.delete(clients.keys().next().value!);
  }
  return api;
}
