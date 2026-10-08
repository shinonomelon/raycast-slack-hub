import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheNamespace,
  FAILURE_TITLES,
  judgeWhoami,
  WHOAMI_TIMEOUT_MS,
  type Identity,
  type IdentityFailureKind,
  type IdentityOutcome,
} from "./identity.ts";
import { planRefresh, refreshAll } from "./refresh-all.ts";

// このテストは Slack も slack-cli も Cache も使わない。whoami・取り直し・出力は、記録するだけの偽物にする

const ME: Identity = {
  userId: "U0000000017",
  user: "taro_y",
  teamId: "T0000000012",
  team: "Example Inc",
  url: "https://example.slack.com/",
};

const DIRS = [{ key: "conversations" }, { key: "people" }, { key: "joined" }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- 背景の取り直しの判断（planRefresh）---------------------------------------------------

const FAILURE_KINDS: IdentityFailureKind[] = [
  "cli-not-found",
  "node-not-found",
  "no-whoami",
  "failed",
];

test("planRefresh：whoami が取れなかったら（どの理由でも）、何もせずに終える。理由（見出しと直し方）は出力に残す文として返す", () => {
  for (const kind of FAILURE_KINDS) {
    const plan = planRefresh({
      kind: "failed",
      failure: {
        kind,
        title: FAILURE_TITLES[kind],
        message: "slack-cli Path を直してください",
      },
    });
    assert.deepEqual(
      plan,
      {
        action: "skip",
        log: `skipped ${FAILURE_TITLES[kind]}: slack-cli Path を直してください`,
      },
      kind,
    );
  }
});

test("planRefresh：whoami が取れたら、その人（ワークスペースと自分の ID）の名前空間で取り直す", () => {
  const plan = planRefresh({ kind: "ok", identity: ME });
  assert.deepEqual(plan, { action: "refresh", identity: ME });
  if (plan.action !== "refresh") return;
  // 取り直した一覧の保存先は、この人の名前空間（自分の情報が決まる前の directory ではない）
  assert.equal(
    cacheNamespace("directory", plan.identity),
    "directory-T0000000012-U0000000017",
  );
});

test("planRefresh：slack-cli が失敗した出力から判断しても、何もせずに終える。出力に残す文に、トークンの形の文字列は残らない", () => {
  const token = "xoxp-1234567890-abcdefghij";
  const outcome = judgeWhoami(
    {
      code: 1,
      signal: null,
      stdout: "",
      stderr: `Error: invalid_auth ${token}`,
      timedOut: false,
      aborted: false,
    },
    WHOAMI_TIMEOUT_MS,
  );
  const plan = planRefresh(outcome);
  assert.equal(plan.action, "skip");
  if (plan.action === "skip") {
    assert.ok(plan.log.includes("invalid_auth"));
    assert.ok(!plan.log.includes(token));
  }
});

test("whoami が取れなければ、何も取り直さず、投げずに終える。理由は出力に残す", async () => {
  const refreshed: string[] = [];
  const logs: string[] = [];
  const outcome: IdentityOutcome = {
    kind: "failed",
    failure: {
      kind: "no-whoami",
      title: FAILURE_TITLES["no-whoami"],
      message: "slack-cli Path を直してください",
    },
  };
  await refreshAll({
    whoami: async () => outcome,
    dirs: DIRS,
    refresh: async (dir) => {
      refreshed.push(dir.key);
      return true;
    },
    log: (line) => logs.push(line),
  });
  // 取り直し（Slack の取得と Cache への書き込み）は1つも呼ばれない
  assert.deepEqual(refreshed, []);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("この slack-cli には whoami がありません"));
  assert.ok(logs[0].includes("slack-cli Path を直してください"));
});

test("whoami が取れるまで、取り直しを始めない。取れたら、その人の自分の情報で、一覧ごとに取り直す", async () => {
  const gate = deferred<IdentityOutcome>();
  const calls: { key: string; identity: Identity }[] = [];
  const logs: string[] = [];
  const running = refreshAll({
    whoami: () => gate.promise,
    dirs: DIRS,
    refresh: async (dir, identity) => {
      calls.push({ key: dir.key, identity });
      return dir.key !== "people";
    },
    log: (line) => logs.push(line),
  });
  await flush();
  assert.equal(calls.length, 0, "whoami が返る前に取り直しを始めている");

  gate.resolve({ kind: "ok", identity: ME });
  await running;
  assert.deepEqual(
    calls.map((call) => call.key),
    ["conversations", "people", "joined"],
  );
  for (const call of calls) assert.deepEqual(call.identity, ME);
  assert.deepEqual(logs, [
    "refreshed conversations=true people=false joined=true",
  ]);
});

test("1つの取り直しが失敗しても、ほかの取り直しは最後まで終わらせてから、まとめて失敗として返す", async () => {
  const slow = deferred<boolean>();
  const finished: string[] = [];
  const logs: string[] = [];
  const running = refreshAll({
    whoami: async () => ({ kind: "ok", identity: ME }),
    dirs: DIRS,
    refresh: async (dir) => {
      if (dir.key === "conversations") throw new Error("channels failed");
      if (dir.key === "people") {
        await slow.promise;
        finished.push(dir.key);
        return true;
      }
      finished.push(dir.key);
      return false;
    },
    log: (line) => logs.push(line),
  });
  const settled = running.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await flush();
  // 時間のかかる取り直し（people）が終わるまで、コマンドは終わらない
  assert.deepEqual(finished, ["joined"]);
  let done = false;
  void settled.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false);

  slow.resolve(true);
  assert.equal(await settled, "conversations: channels failed");
  assert.deepEqual(finished, ["joined", "people"]);
  assert.deepEqual(logs, [
    "refreshed conversations=failed people=true joined=false",
  ]);
});
