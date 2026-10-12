import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DirectoryRefreshStore } from "./directory-refresh-store.ts";
import { scanDirectory } from "./directory-pages.ts";
import { SlackApiError, type ApiCall } from "./slack-api.ts";
import { backgroundPreflight } from "./directory-schedule.ts";
const identity = {
  teamId: "T1",
  userId: "U1",
  user: "test",
  team: "test",
  url: "https://example.com",
};
function setup() {
  const root = mkdtempSync(join(process.cwd(), ".scratch/directory-test-"));
  return {
    store: new DirectoryRefreshStore(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("successful pages survive 429 and resume without repeating page one", async () => {
  const { store, cleanup } = setup();
  let time = 1000;
  const calls: string[] = [];
  let paused = false;
  const api: ApiCall = async (_method, params, options) => {
    assert.equal(options?.deadlineAt, time + 45000);
    const cursor = String(params?.cursor ?? "");
    calls.push(cursor);
    if (!cursor)
      return {
        channels: [{ id: "C1" }],
        response_metadata: { next_cursor: "next" },
      };
    if (!paused) {
      paused = true;
      throw new SlackApiError("rate_limited", "limited", 900);
    }
    return { channels: [{ id: "C2" }] };
  };
  const args = {
    api,
    credentialKey: "credential",
    kind: "channels",
    method: "conversations.list" as const,
    field: "channels",
    params: {},
    store,
    now: () => time,
  };
  try {
    assert.equal((await scanDirectory(args)).kind, "pending");
    time += 300000;
    assert.equal((await scanDirectory(args)).kind, "pending");
    assert.deepEqual(calls, ["", "next"]);
    time += 600000;
    const result = await scanDirectory(args);
    assert.equal(result.kind, "complete");
    if (result.kind === "complete")
      assert.deepEqual(result.rows, [{ id: "C1" }, { id: "C2" }]);
    assert.deepEqual(calls, ["", "next", "next"]);
  } finally {
    cleanup();
  }
});
test("simultaneous acquisition returns busy and never publishes partial rows", async () => {
  const { store, cleanup } = setup();
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  let calls = 0;
  const args = {
    api: (async () => {
      calls++;
      await gate;
      return { members: [] };
    }) as ApiCall,
    credentialKey: "credential",
    kind: "people",
    method: "users.list" as const,
    field: "members",
    params: {},
    store,
  };
  try {
    const first = scanDirectory(args);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await scanDirectory(args), { kind: "busy" });
    resolve();
    assert.equal((await first).kind, "complete");
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});
test("page budget checkpoints; different credential and conditions cannot reuse it", async () => {
  const { store, cleanup } = setup();
  const cursors: unknown[] = [];
  const args = {
    api: (async (_m, p) => {
      cursors.push(p?.cursor);
      return { channels: [], response_metadata: { next_cursor: "next" } };
    }) as ApiCall,
    credentialKey: "A",
    kind: "channels",
    method: "conversations.list" as const,
    field: "channels",
    params: {},
    store,
    maxPages: 1,
  };
  try {
    assert.equal((await scanDirectory(args)).kind, "pending");
    await scanDirectory({ ...args, credentialKey: "B" });
    await scanDirectory({ ...args, params: { types: "private_channel" } });
    assert.deepEqual(cursors, [undefined, undefined, undefined]);
  } finally {
    cleanup();
  }
});
test("background schedule checks off, intervals, corruption and manual launch before auth", () => {
  const base = {
    background: true,
    frequency: "30m",
    intervalMs: 1800000,
    now: 2000000,
    lastStartedAt: 1500000,
    identity,
    allFresh: false,
  };
  assert.equal(backgroundPreflight(base), "scheduled");
  assert.equal(backgroundPreflight({ ...base, frequency: "off" }), "off");
  assert.equal(
    backgroundPreflight({ ...base, background: false, frequency: "off" }),
    "run",
  );
  assert.equal(backgroundPreflight({ ...base, lastStartedAt: 3000000 }), "run");
  assert.equal(backgroundPreflight({ ...base, identity: undefined }), "run");
  assert.equal(
    backgroundPreflight({ ...base, lastStartedAt: undefined, allFresh: true }),
    "run",
  );
  assert.equal(backgroundPreflight({ ...base, now: 4000000 }), "run");
  assert.equal(
    backgroundPreflight({ ...base, now: 4000000, intervalMs: 10800000 }),
    "scheduled",
  );
});

test("separate processes share acquisition and resume storage", async () => {
  const { store, cleanup } = setup();
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const scannerUrl = pathToFileURL(
    join(process.cwd(), "src/slack/directory-pages.ts"),
  ).href;
  const storeUrl = pathToFileURL(
    join(process.cwd(), "src/slack/directory-refresh-store.ts"),
  ).href;
  const script = `import {scanDirectory} from ${JSON.stringify(scannerUrl)}; import {DirectoryRefreshStore} from ${JSON.stringify(storeUrl)};
    const store = new DirectoryRefreshStore(process.argv[1]);
    const result = await scanDirectory({store,credentialKey:'shared',kind:'people',method:'users.list',field:'members',params:{},maxPages:1,api:async (_m,p)=>{process.stdout.write('CALL:'+String(p.cursor??'first')+'\\n'); await new Promise(r=>setTimeout(r,250));return {members:[{id:p.cursor??'first'}],response_metadata:p.cursor?{}:{next_cursor:'second'}}}});
    process.stdout.write('RESULT:'+JSON.stringify(result)+'\\n');`;
  const launch = () => {
    const child = spawn(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "-e",
      script,
      store.root,
    ]);
    let output = "";
    let callResolve!: () => void;
    const called = new Promise<void>((r) => (callResolve = r));
    child.stdout.on("data", (data) => {
      output += String(data);
      if (output.includes("CALL:")) callResolve();
    });
    const done = new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(output) : reject(new Error(`child exit ${code}`)),
      );
    });
    return { called, done };
  };
  try {
    const first = launch();
    await first.called;
    const second = launch();
    assert.match(await second.done, /"kind":"busy"/);
    assert.match(await first.done, /"kind":"pending"/);
    const resumed = await launch().done;
    assert.match(resumed, /CALL:second/);
    assert.ok(!resumed.includes("CALL:first"));
    assert.match(resumed, /"kind":"complete"/);
    assert.match(resumed, /"rows":\[{"id":"first"},{"id":"second"}\]/);
  } finally {
    cleanup();
  }
});
