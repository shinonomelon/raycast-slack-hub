import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createChannelLibraryStore,
  LibraryStoreError,
  type SaveStage,
} from "./store.ts";
const identity = { teamId: "T1", userId: "U1" };
const directory = [{ id: "C1", name: "channel", type: "public" as const }];
function temporary() {
  const base = join(process.cwd(), ".scratch");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "channel-library-test-"));
}
const source = pathToFileURL(
  join(process.cwd(), "src/features/channel-library/store.ts"),
).href;
test("各保存境界で停止して再起動しても正本と取り込み記録は同時に確定", async () => {
  for (const stage of [
    "before-write",
    "after-write",
    "before-rename",
    "after-rename",
  ] as SaveStage[]) {
    const root = temporary();
    try {
      const failing = createChannelLibraryStore(root, {
        checkpoint: (current) => {
          if (current === stage) throw new Error("injected failure");
        },
      });
      await assert.rejects(
        failing.initialize(identity, directory, true, ["C1"]),
      );
      const fresh = createChannelLibraryStore(root);
      const before = await fresh.load(identity);
      assert.equal(before.ready, stage === "after-rename");
      await fresh.initialize(identity, directory, true, ["C1"]);
      const document = JSON.parse(
        readFileSync(join(root, "channel-library.json"), "utf8"),
      );
      assert.deepEqual(document.accounts["T1-U1"].favoriteChannelIds, ["C1"]);
      assert.equal(document.legacyClaims.C1, "T1-U1");
      assert.deepEqual(readdirSync(root), ["channel-library.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("最新正本へ差分を適用し別store・別accountの変更を失わない", async () => {
  const root = temporary();
  try {
    const a = createChannelLibraryStore(root),
      b = createChannelLibraryStore(root);
    await a.initialize(identity, directory, true, []);
    await b.load(identity);
    await a.mutate(identity, { kind: "create-section", name: "開発" });
    await b.mutate(identity, {
      kind: "favorite",
      channelId: "C1",
      favorite: true,
    });
    await b.initialize({ teamId: "T2", userId: "U2" }, directory, true, ["C1"]);
    assert.equal((await a.load(identity)).library.sections.length, 1);
    assert.deepEqual((await a.load(identity)).library.favoriteChannelIds, [
      "C1",
    ]);
    assert.deepEqual(
      (await a.load({ teamId: "T3", userId: "U3" })).library.favoriteChannelIds,
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("生存PIDまたは所有者欠落のlockは保存を止め、壊れた正本も上書きしない", async () => {
  const root = temporary();
  try {
    const store = createChannelLibraryStore(root),
      lock = join(root, "channel-library.json.lock");
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, nonce: "live" }),
    );
    await assert.rejects(
      store.initialize(identity, directory, true, ["C1"]),
      (error) => error instanceof LibraryStoreError && error.code === "locked",
    );
    rmSync(join(lock, "owner.json"));
    await assert.rejects(
      store.initialize(identity, directory, true, ["C1"]),
      (error) =>
        error instanceof LibraryStoreError && error.code === "recovery",
    );
    rmSync(lock, { recursive: true });
    writeFileSync(join(root, "channel-library.json"), "broken");
    await assert.rejects(store.initialize(identity, directory, true, ["C1"]));
    assert.equal(
      readFileSync(join(root, "channel-library.json"), "utf8"),
      "broken",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("保存前のサイズ超過は旧正本を保持", async () => {
  const root = temporary();
  try {
    const store = createChannelLibraryStore(root);
    await store.initialize(identity, directory, true, []);
    const before = readFileSync(join(root, "channel-library.json"), "utf8");
    const small = createChannelLibraryStore(root, {
      maxBytes: Buffer.byteLength(before) + 5,
    });
    await assert.rejects(
      small.mutate(identity, {
        kind: "create-section",
        name: "大きな追加データ",
      }),
    );
    assert.equal(
      readFileSync(join(root, "channel-library.json"), "utf8"),
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("異常終了PIDのlockだけを回復しrename前の移行を再実行", async () => {
  const root = temporary();
  try {
    const script = `import {createChannelLibraryStore} from ${JSON.stringify(source)}; await createChannelLibraryStore(${JSON.stringify(root)}, {checkpoint:stage=>{if(stage==='before-rename')process.exit(7)}}).initialize(${JSON.stringify(identity)},${JSON.stringify(directory)},true,['C1']);`;
    const child = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "-e",
      script,
    ]);
    assert.equal(child.status, 7, child.stderr.toString());
    const result = await createChannelLibraryStore(root).initialize(
      identity,
      directory,
      true,
      ["C1"],
    );
    assert.deepEqual(result.library.favoriteChannelIds, ["C1"]);
    assert.equal(result.ready, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("独立プロセスの同時保存は排他・再試行により両方の変更を残す", async () => {
  const root = temporary();
  try {
    await createChannelLibraryStore(root).initialize(
      identity,
      directory,
      true,
      [],
    );
    const run = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const script = `import {createChannelLibraryStore} from ${JSON.stringify(source)}; const store=createChannelLibraryStore(${JSON.stringify(root)}); for(let n=0;n<100;n++){try{await store.mutate(${JSON.stringify(identity)},{kind:'create-section',name:${JSON.stringify(name)}});process.exit(0)}catch(e){if(e.code!=='locked'&&e.code!=='recovery')throw e;await new Promise(r=>setTimeout(r,10))}}process.exit(9);`;
        const child = spawn(process.execPath, [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "--input-type=module",
          "-e",
          script,
        ]);
        let error = "";
        child.stderr.on("data", (value) => {
          error += value;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(error || `exit ${code}`)),
        );
      });
    await Promise.all([run("開発"), run("今週")]);
    assert.deepEqual(
      (await createChannelLibraryStore(root).load(identity)).library.sections
        .map((s) => s.name)
        .sort(),
      ["今週", "開発"].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("既存accountは未完了directoryでも読め、未移行accountへの編集は空移行を確定しない", async () => {
  const root = temporary();
  try {
    const store = createChannelLibraryStore(root);
    assert.equal(
      (await store.initialize(identity, directory, false, ["C1"])).ready,
      false,
    );
    await assert.rejects(
      store.mutate(identity, {
        kind: "favorite",
        channelId: "C1",
        favorite: true,
      }),
    );
    assert.equal(readdirSync(root).includes("channel-library.json"), false);
    await store.initialize(identity, directory, true, ["C1"]);
    await store.mutate(identity, {
      kind: "favorite",
      channelId: "C1",
      favorite: false,
    });
    assert.equal(
      (await store.initialize(identity, [], false, ["C1"])).ready,
      true,
    );
    assert.deepEqual(
      (await store.initialize(identity, directory, true, ["C1"])).library
        .favoriteChannelIds,
      [],
    );
    const other = await store.initialize(
      { teamId: "T2", userId: "U2" },
      directory,
      true,
      ["C1"],
    );
    assert.deepEqual(other.library.favoriteChannelIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("途中まで書かれた一時ファイルでも正本を置き換えず再起動後に移行できる", async () => {
  const root = temporary();
  try {
    const store = createChannelLibraryStore(root, {
      checkpoint: (stage) => {
        if (stage === "after-write") {
          const file = readdirSync(root).find((name) => name.endsWith(".tmp"))!;
          writeFileSync(join(root, file), '{"version":');
          throw new Error("partial write");
        }
      },
    });
    await assert.rejects(store.initialize(identity, directory, true, ["C1"]));
    assert.equal(
      (await createChannelLibraryStore(root).load(identity)).ready,
      false,
    );
    assert.deepEqual(
      (
        await createChannelLibraryStore(root).initialize(
          identity,
          directory,
          true,
          ["C1"],
        )
      ).library.favoriteChannelIds,
      ["C1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename後にプロセスが停止してもclaimsを再配布せず新正本から復帰", async () => {
  const root = temporary();
  try {
    const script = `import {createChannelLibraryStore} from ${JSON.stringify(source)}; await createChannelLibraryStore(${JSON.stringify(root)}, {checkpoint:stage=>{if(stage==='after-rename')process.exit(7)}}).initialize(${JSON.stringify(identity)},${JSON.stringify(directory)},true,['C1']);`;
    const child = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "-e",
      script,
    ]);
    assert.equal(child.status, 7, child.stderr.toString());
    const store = createChannelLibraryStore(root);
    assert.equal((await store.load(identity)).ready, true);
    assert.deepEqual(
      (
        await store.initialize(
          { teamId: "T2", userId: "U2" },
          directory,
          true,
          ["C1"],
        )
      ).library.favoriteChannelIds,
      [],
    );
    assert.deepEqual((await store.load(identity)).library.favoriteChannelIds, [
      "C1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
