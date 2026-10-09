import assert from "node:assert/strict";
import { test } from "node:test";
import { MembershipController } from "./membership-controller.ts";
import { MembershipCache } from "./membership-cache.ts";
import type { MembershipState } from "./membership.ts";
import type { Session } from "../../slack/identity.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
const identity = {
  teamId: "T1",
  userId: "U1",
  user: "self",
  team: "team",
  url: "https://example.test",
};
const session = (api: ApiCall, userId = "U1"): Session => ({
  canFetch: true,
  api,
  display: { ...identity, userId },
  fetchAs: { ...identity, userId },
});
const target = (ids = ["U2"]) => ({ kind: "channels" as const, userIds: ids });
const channels = (ids: string[]) => ({
  ok: true,
  channels: ids.map((id) => ({ id, name: id })),
});
test("ANDとTTL再利用、Refreshで全員を取り直す", async () => {
  const calls: string[] = [];
  const api: ApiCall = async (_method, params) => {
    calls.push(String(params?.user));
    return channels(params?.user === "U2" ? ["C1", "C2"] : ["C2", "C3"]);
  };
  const states: MembershipState[] = [];
  const controller = new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => 0,
  );
  await controller.load(session(api), target());
  await controller.load(session(api), target(["U2", "U3"]));
  assert.deepEqual(calls, ["U2", "U3"]);
  assert.deepEqual(states.at(-1)?.data, [
    { id: "C2", name: "C2", type: "public" },
  ]);
  await controller.load(session(api), target(["U2", "U3"]), true);
  assert.deepEqual(calls, ["U2", "U3", "U2", "U3"]);
  await controller.load(session(api), target());
  assert.equal(states.at(-1)?.data.length, 2);
});
test("人を追加する時点で期限切れの既存選択者も取り直す", async () => {
  let now = 0;
  const calls: string[] = [];
  const api: ApiCall = async (_method, params) => {
    calls.push(String(params?.user));
    return channels(["C1"]);
  };
  const controller = new MembershipController(
    () => {},
    new MembershipCache(),
    () => now,
  );
  await controller.load(session(api), target());
  now = 120000;
  await controller.load(session(api), target(["U2", "U3"]));
  assert.deepEqual(calls, ["U2", "U2", "U3"]);
});
test("認証未完了は既存キャッシュもHTTPも利用しない", async () => {
  let calls = 0;
  const api: ApiCall = async () => {
    calls++;
    return channels(["C1"]);
  };
  const states: MembershipState[] = [];
  const controller = new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => 0,
  );
  await controller.load(session(api), target());
  await controller.load(
    { canFetch: false, display: identity, fetchAs: undefined, api },
    target(),
  );
  assert.equal(calls, 1);
  assert.equal(states.at(-1)?.status, "auth-required");
  assert.deepEqual(states.at(-1)?.data, []);
});
for (const mode of ["target", "account", "api", "close"] as const) {
  test(`取消後の遅延成功は表示・保存しない ${mode}`, async () => {
    let resolve!: (data: Record<string, unknown>) => void;
    const cache = new MembershipCache();
    const states: MembershipState[] = [];
    let calls = 0;
    const api: ApiCall = async () =>
      ++calls === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : channels(["C2"]);
    const controller = new MembershipController(
      (state) => states.push(state),
      cache,
      () => 0,
    );
    const old = controller.load(session(api), target());
    if (mode === "close") controller.cancel();
    else {
      const nextApi: ApiCall = async () => channels(["C2"]);
      if (mode === "target") void controller.load(session(api), target(["U3"]));
      else
        await controller.load(
          session(
            mode === "api" ? nextApi : api,
            mode === "account" ? "U9" : "U1",
          ),
          target(),
        );
    }
    resolve(channels(["C1"]));
    await old;
    controller.cancel();
    await new Promise((done) => setImmediate(done));
    assert.equal(
      cache.get(api, "T1-U1", "channels:U2:public_channel,private_channel", 0),
      undefined,
    );
    assert.ok(
      !states.some(
        (state) =>
          state.status === "ready" &&
          state.data.some(
            (value) => typeof value !== "string" && value.id === "C1",
          ),
      ),
    );
  });
}
test("全員取得の途中失敗は前の人の成功も保存しない", async () => {
  const cache = new MembershipCache();
  const states: MembershipState[] = [];
  const api: ApiCall = async (_method, params) => {
    if (params?.user === "U3")
      throw new SlackApiError("api", "missing", undefined, "missing_scope");
    return channels(["C1"]);
  };
  const controller = new MembershipController(
    (state) => states.push(state),
    cache,
    () => 0,
  );
  await controller.load(session(api), target(["U2", "U3"]));
  assert.equal(states.at(-1)?.status, "failed");
  assert.deepEqual(states.at(-1)?.data, []);
  assert.equal(
    cache.get(api, "T1-U1", "channels:U2:public_channel,private_channel", 0),
    undefined,
  );
});
test("429は秒数を返し再試行せず同条件の前回結果だけ残す", async () => {
  let calls = 0;
  const states: MembershipState[] = [];
  const api: ApiCall = async () => {
    if (++calls > 1) throw new SlackApiError("rate_limited", "secret", 13);
    return channels(["C1"]);
  };
  const controller = new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => 0,
  );
  await controller.load(session(api), target());
  await controller.load(session(api), target(), true);
  assert.equal(calls, 2);
  assert.equal(states.at(-1)?.status, "rate-limited");
  assert.equal(states.at(-1)?.retryAfter, 13);
  assert.equal(states.at(-1)?.previous, true);
  assert.equal(states.at(-1)?.data.length, 1);
  assert.ok(!states.at(-1)?.error?.includes("secret"));
});
test("複数人は共通30秒以内の残り時間を使う", async () => {
  let now = 0;
  const times: number[] = [];
  const states: MembershipState[] = [];
  const api: ApiCall = async (_method, _params, options) => {
    times.push(options!.timeoutMs!);
    now += 16000;
    return channels(["C1"]);
  };
  await new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => now,
  ).load(session(api), target(["U2", "U3"]));
  assert.deepEqual(times, [30000, 14000]);
  assert.equal(states.at(-1)?.status, "failed");
});
test("メンバー成功だけを完全結果として保存し安全な例外表示を行う", async () => {
  const states: MembershipState[] = [];
  let fail = false;
  const api: ApiCall = async () => {
    if (fail) throw new Error("xoxp-secret");
    return { ok: true, members: ["U1", "U2"] };
  };
  const controller = new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => 0,
  );
  await controller.load(session(api), { kind: "members", channelId: "C1" });
  assert.deepEqual(states.at(-1)?.data, ["U1", "U2"]);
  fail = true;
  await controller.load(session(api), { kind: "members", channelId: "C2" });
  assert.equal(states.at(-1)?.status, "failed");
  assert.deepEqual(states.at(-1)?.data, []);
  assert.ok(!states.at(-1)?.error?.includes("xoxp"));
});
test("APIが応答しなくても30秒で失敗し取消する", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const states: MembershipState[] = [];
  let signal: AbortSignal | undefined;
  const api: ApiCall = async (_method, _params, options) => {
    signal = options?.signal;
    return new Promise(() => {});
  };
  const pending = new MembershipController(
    (state) => states.push(state),
    new MembershipCache(),
    () => 0,
  ).load(session(api), target());
  context.mock.timers.tick(30000);
  await pending;
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(signal?.aborted, true);
});
for (const ids of [[], ["U2", "U2"], ["U1", "U2", "U3", "U4", "U5", "U6"]]) {
  test(`不正な選択人数はHTTPゼロ ${JSON.stringify(ids)}`, async () => {
    let calls = 0;
    const states: MembershipState[] = [];
    const api: ApiCall = async () => {
      calls++;
      return channels([]);
    };
    await new MembershipController((state) => states.push(state)).load(
      session(api),
      target(ids),
    );
    assert.equal(calls, 0);
    assert.equal(states.at(-1)?.status, "failed");
  });
}
