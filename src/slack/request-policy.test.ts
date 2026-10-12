import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSlackApi, SlackApiError } from "./slack-api.ts";
import { createRequestPolicy } from "./request-policy.ts";
import { createRequestPolicyStore } from "./request-policy-store.ts";
import { acquireFileLease } from "./file-lease.ts";
import { createRequestMetrics } from "./request-metrics.ts";
const key = createHash("sha256").update("test").digest("hex");
const root = () => mkdtempSync(join(process.cwd(), ".scratch", "policy-test-"));
test("仮想時計で間隔を共有し、待機予算超過は延期する", async () => {
  const path = root();
  let time = 100000;
  try {
    const store = createRequestPolicyStore(path, () => time);
    const policy = createRequestPolicy({
      credentialKey: key,
      store,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    await policy.beforeSend("search.messages", {});
    assert.equal(await policy.beforeSend("search.messages", {}), 3100);
    await policy.beforeSend("conversations.history", {});
    await assert.rejects(
      policy.beforeSend("conversations.history", { deadlineAt: time + 1000 }),
      (e: unknown) =>
        e instanceof SlackApiError &&
        e.kind === "deferred" &&
        e.retryAt === time + 60000,
    );
    const other = createRequestPolicy({
      credentialKey: key,
      store,
      now: () => time,
    });
    await policy.pause("users.list", 900);
    await assert.rejects(
      other.beforeSend("users.list", {}),
      (e: unknown) =>
        e instanceof SlackApiError &&
        e.kind === "rate_limited" &&
        e.retryAfter === 900,
    );
    await other.beforeSend("auth.test", {});
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("購読者の中断を分離し、共有は取得中だけに限る", async () => {
  let calls = 0;
  let resolve!: (response: Response) => void;
  const api = createSlackApi("xoxp-test", async () => {
    calls++;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  const controller = new AbortController();
  const first = api(
    "search.messages",
    { query: "same" },
    { signal: controller.signal },
  );
  const second = api("search.messages", { query: "same" });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(
    first,
    (e: unknown) => e instanceof SlackApiError && e.kind === "aborted",
  );
  resolve(new Response(JSON.stringify({ ok: true })));
  await second;
  assert.equal(calls, 1);
  const third = api("search.messages", { query: "same" });
  await Promise.resolve();
  resolve(new Response(JSON.stringify({ ok: true })));
  await third;
  assert.equal(calls, 2);
});
test("期限切れの旧所有者は新所有者のロックを解放しない", () => {
  const path = root();
  let time = Date.now();
  try {
    const first = acquireFileLease(join(path, "lock"), 100, () => time)!;
    time += 101;
    const second = acquireFileLease(join(path, "lock"), 100, () => time)!;
    assert.equal(first.isOwner(), false);
    first.release();
    assert.equal(second.isOwner(), true);
    second.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
const child = (code: string) =>
  new Promise<void>((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--input-type=module",
        "-e",
        code,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    process.stderr.on("data", (b) => {
      errors += b;
    });
    process.on("exit", (status) =>
      status === 0 ? resolve() : reject(new Error(errors)),
    );
  });
test("別プロセスの同時開始でも送信枠は一件だけ確保する", async () => {
  const path = root();
  try {
    const code = `import {createRequestPolicyStore} from './src/slack/request-policy-store.ts'; import {createRequestPolicy} from './src/slack/request-policy.ts'; const p=createRequestPolicy({credentialKey:${JSON.stringify(key)},store:createRequestPolicyStore(${JSON.stringify(path)}),now:()=>100000}); try {await p.beforeSend('search.messages',{deadlineAt:100001});} catch(e) { if(e.kind!=='deferred') throw e; }`;
    await Promise.all([child(code), child(code), child(code)]);
    const state = JSON.parse(
      readFileSync(join(path, `${key}-search.messages.json`), "utf8"),
    );
    assert.equal(state.nextStartAt, 103100);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("診断には本文・トークン・検索式・IDを記録しない", async () => {
  const path = root();
  try {
    const metricsPath = join(path, "metrics.json");
    const api = createSlackApi(
      "xoxp-secret",
      async () => new Response(JSON.stringify({ ok: true })),
      { metrics: createRequestMetrics(metricsPath) },
    );
    await api(
      "search.messages",
      { query: "query-secret", channel: "CSECRET" },
      { source: "search" },
    );
    const raw = readFileSync(metricsPath, "utf8");
    assert.doesNotMatch(raw, /xoxp|query-secret|CSECRET/);
    assert.equal(JSON.parse(raw)[0].requests, 1);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("強制終了した別プロセスのロックは期限前でも復旧する", async () => {
  const path = root();
  const lock = join(path, "killed-lock");
  const code = `import {acquireFileLease} from './src/slack/file-lease.ts'; acquireFileLease(${JSON.stringify(lock)},60000); console.log('ready'); setInterval(()=>{},1000);`;
  const worker = spawn(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "-e",
      code,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      worker.stdout.once("data", () => resolve());
      worker.once("error", reject);
    });
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    mkdirSync(`${lock}.guard`);
    writeFileSync(`${lock}.guard/pid`, String(worker.pid));
    mkdirSync(`${lock}.guard.recovery`);
    writeFileSync(`${lock}.guard.recovery/pid`, String(worker.pid));
    const lease = acquireFileLease(lock, 60000);
    assert.ok(lease);
    lease.release();
  } finally {
    worker.kill("SIGKILL");
    rmSync(path, { recursive: true, force: true });
  }
});
test("共有通信の短い購読期限は他の購読者を中断しない", async () => {
  let calls = 0;
  let resolve!: (response: Response) => void;
  const api = createSlackApi("xoxp-test", async () => {
    calls++;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  const first = api(
    "conversations.replies",
    { channel: "C1" },
    { deadlineAt: Date.now() + 10 },
  );
  await Promise.resolve();
  const second = api(
    "conversations.replies",
    { channel: "C1" },
    { deadlineAt: Date.now() + 1000 },
  );
  await assert.rejects(
    first,
    (e: unknown) => e instanceof SlackApiError && e.kind === "timeout",
  );
  resolve(new Response(JSON.stringify({ ok: true })));
  await second;
  assert.equal(calls, 1);
});
test("時計の巻き戻りでも期限付きロックを復旧できる", () => {
  const path = root();
  let time = Date.now();
  try {
    const first = acquireFileLease(join(path, "rollback"), 60000, () => time)!;
    time -= 10000;
    const second = acquireFileLease(join(path, "rollback"), 60000, () => time);
    assert.ok(second);
    first.release();
    assert.equal(second.isOwner(), true);
    second.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
