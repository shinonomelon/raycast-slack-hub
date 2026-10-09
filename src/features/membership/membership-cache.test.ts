import assert from "node:assert/strict";
import { test } from "node:test";
import { MembershipCache } from "./membership-cache.ts";
import type { ApiCall } from "../../slack/slack-api.ts";
const api: ApiCall = async () => ({ ok: true });
test("TTL境界と別api・別アカウントを隔離する", () => {
  const cache = new MembershipCache();
  cache.set(api, "T1-U1", "members:C1", { data: ["U1"], fetchedAt: 0 });
  assert.ok(cache.get(api, "T1-U1", "members:C1", 119999));
  assert.equal(
    cache.get(async () => ({}), "T1-U1", "members:C1", 0),
    undefined,
  );
  assert.equal(cache.get(api, "T1-U2", "members:C1", 0), undefined);
  assert.equal(cache.get(api, "T1-U1", "members:C1", 120000), undefined);
});
test("20エントリ上限をLRUで追い出す", () => {
  const cache = new MembershipCache();
  for (let i = 0; i < 20; i++)
    cache.set(api, "scope", String(i), { data: ["U1"], fetchedAt: 0 });
  cache.get(api, "scope", "0", 0);
  cache.set(api, "scope", "20", { data: ["U1"], fetchedAt: 0 });
  assert.ok(cache.get(api, "scope", "0", 0));
  assert.equal(cache.get(api, "scope", "1", 0), undefined);
});
test("合計10000ID上限と単独超過を守る", () => {
  const cache = new MembershipCache();
  cache.set(api, "scope", "a", {
    data: Array.from({ length: 6000 }, (_, i) => `U${i}`),
    fetchedAt: 0,
  });
  cache.set(api, "scope", "b", {
    data: Array.from({ length: 5000 }, (_, i) => `U${i}`),
    fetchedAt: 0,
  });
  assert.equal(cache.get(api, "scope", "a", 0), undefined);
  assert.ok(cache.get(api, "scope", "b", 0));
  cache.set(api, "scope", "huge", {
    data: Array.from({ length: 10001 }, (_, i) => `U${i}`),
    fetchedAt: 0,
  });
  assert.equal(cache.get(api, "scope", "huge", 0), undefined);
});
test("呼び出し元の配列変更でキャッシュを変更できない", () => {
  const cache = new MembershipCache();
  const data = [{ id: "C1", name: "original", type: "public" as const }];
  cache.set(api, "scope", "c", { data, fetchedAt: 0 });
  data[0].name = "changed";
  const entry = cache.get(api, "scope", "c", 0)!;
  assert.equal((entry.data[0] as { name: string }).name, "original");
});
