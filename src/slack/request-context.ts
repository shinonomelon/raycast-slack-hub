import type { ApiCall, ApiSource } from "./slack-api.ts";
import type { RequestMetrics } from "./request-metrics.ts";
const metadata = new WeakMap<
  ApiCall,
  { key: string; metrics?: RequestMetrics }
>();
export function setApiContext(
  api: ApiCall,
  key: string,
  metrics?: RequestMetrics,
) {
  metadata.set(api, { key, metrics });
}
export function getApiCredentialKey(api: ApiCall): string | undefined {
  return metadata.get(api)?.key;
}
export function apiWithSource(api: ApiCall, source: ApiSource): ApiCall {
  const wrapped: ApiCall = (method, params, options) =>
    api(method, params, { ...options, source });
  const data = metadata.get(api);
  if (data) metadata.set(wrapped, data);
  return wrapped;
}
export function recordRequestCacheHit(api: ApiCall, source: ApiSource) {
  metadata.get(api)?.metrics?.record(source, "cache", "cacheHits");
}
export function copyApiContext(from: ApiCall, to: ApiCall): void {
  const data = metadata.get(from);
  if (data) metadata.set(to, data);
}
