// 同じトークンの画面はAPIクライアントを共有する。認証情報は表示・永続保存しない。
import { createHash } from "node:crypto";
import { createSlackApi, type ApiCall } from "./slack-api.ts";
const clients = new Map<string, ApiCall>();
export function apiForToken(token: string): ApiCall {
  const key = createHash("sha256").update(token.trim()).digest("hex");
  let api = clients.get(key);
  if (!api) {
    api = createSlackApi(token);
    clients.set(key, api);
    if (clients.size > 4) clients.delete(clients.keys().next().value!);
  }
  return api;
}
