import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildInvocation,
  createRun,
  failureMessage,
  isFile,
  missingError,
  runProcess,
  searchDirs,
  type CliSettings,
  type Invocation,
  type LaunchEnv,
} from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// この拡張のテストは Slack を呼ばない。slack-cli の dist も起動せず、node の短いスクリプトで確かめる

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// 条件が満たされるまで 50 ミリ秒おきに調べる。満たされたら true、時間内に満たされなければ false
async function waitUntil(
  predicate: () => boolean,
  limitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

// 実行中のプロセスのうち、コマンドラインに印を含むものの、コマンドライン。シェルを通さずに ps を直接呼ぶ
// （シェル経由だと sh -c 自身のコマンドラインに印が入り、自分に当たる）
function markedCommands(marker: string): string[] {
  const result = spawnSync("ps", ["-A", "-ww", "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `ps が失敗しました: status=${result.status} ${result.stderr}`,
    );
  }
  return result.stdout.split("\n").filter((line) => line.includes(marker));
}

// 実行中のプロセスのうち、コマンドラインに印を含むものの数
const countProcesses = (marker: string): number =>
  markedCommands(marker).length;

// node で短いスクリプトを動かす呼び出し（volta を通さない）
const plainNode = (...args: string[]): Invocation => ({
  command: process.execPath,
  args,
  cwd: process.cwd(),
  env: process.env,
});

// ---- 呼び出しの組み立て ----------------------------------------------------------

const HOME = "/Users/example";

// 設定が空のとき。決まった場所から slack-cli を探す
const noSettings: CliSettings = {
  slackCliPath: "",
  nodePath: "",
  slackCliProfile: "",
};

// 偽の実行環境。files にあるパスだけが「ある」ことにし、調べられたパスを順に checked へ残す
function fakeEnv(
  files: readonly string[],
  baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/local/bin", KEEP: "1" },
) {
  const checked: string[] = [];
  const env: LaunchEnv = {
    home: HOME,
    baseEnv,
    exists: (path) => {
      checked.push(path);
      return files.includes(path);
    },
  };
  return { env, checked };
}

// 組み立てに成功した呼び方を返す。失敗していたら、テストを落とす
function invocationOf(
  args: readonly string[],
  settings: CliSettings,
  files: readonly string[],
): Invocation {
  const result = buildInvocation(args, settings, fakeEnv(files).env);
  if (result.kind !== "ok") {
    assert.fail(`組み立てに失敗しました: ${JSON.stringify(result.missing)}`);
  }
  return result.invocation;
}

const VOLTA_CLI = `${HOME}/.volta/bin/slack-cli`;
const BREW_CLI = "/opt/homebrew/bin/slack-cli";
const LOCAL_CLI = "/usr/local/bin/slack-cli";
const VOLTA_NODE = `${HOME}/.volta/bin/node`;
const BREW_NODE = "/opt/homebrew/bin/node";
const LOCAL_NODE = "/usr/local/bin/node";
const SCRIPT = `${HOME}/slack-cli/dist/index.js`;

test("探す場所は、~/.volta/bin・/opt/homebrew/bin・/usr/local/bin の順", () => {
  assert.deepEqual(searchDirs(HOME), [
    `${HOME}/.volta/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
});

test("設定が空なら、決まった場所から slack-cli を探して、そのまま動かす。引数は渡したままで、--profile は付けない", () => {
  const invocation = invocationOf(
    ["channels", "--type", "public", "--format", "json"],
    noSettings,
    [BREW_CLI],
  );
  assert.equal(invocation.command, BREW_CLI);
  assert.deepEqual(invocation.args, [
    "channels",
    "--type",
    "public",
    "--format",
    "json",
  ]);
});

test("設定が空のとき、複数の場所にあれば、先に探す場所のものを使う", () => {
  assert.equal(
    invocationOf([], noSettings, [LOCAL_CLI, BREW_CLI, VOLTA_CLI]).command,
    VOLTA_CLI,
  );
  assert.equal(
    invocationOf([], noSettings, [LOCAL_CLI, BREW_CLI]).command,
    BREW_CLI,
  );
  assert.equal(invocationOf([], noSettings, [LOCAL_CLI]).command, LOCAL_CLI);
});

test("見つけた slack-cli のフォルダを PATH の先頭に足す。/usr/bin:/bin と、元の PATH・ほかの環境変数・cwd（ホーム）は残す", () => {
  const { env } = fakeEnv([BREW_CLI], { PATH: "/usr/local/bin", KEEP: "1" });
  const result = buildInvocation(["status"], noSettings, env);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(
    result.invocation.env.PATH,
    "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin",
  );
  assert.equal(result.invocation.env.KEEP, "1");
  // volta の都合でホームから実行する
  assert.equal(result.invocation.cwd, HOME);
});

test("元の PATH が無いときも、PATH の末尾に空の項目（カレントフォルダ）を足さない", () => {
  const { env } = fakeEnv([BREW_CLI], {});
  const result = buildInvocation([], noSettings, env);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.invocation.env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("slack-cli Path が .js でなければ、そのパスの slack-cli をそのまま動かす。Node Path は使わず、PATH の先頭は slack-cli のフォルダ", () => {
  const invocation = invocationOf(
    ["whoami"],
    {
      slackCliPath: "/opt/homebrew/bin/slack-cli",
      nodePath: "/somewhere/node",
      slackCliProfile: "",
    },
    ["/opt/homebrew/bin/slack-cli"],
  );
  assert.equal(invocation.command, "/opt/homebrew/bin/slack-cli");
  assert.deepEqual(invocation.args, ["whoami"]);
  assert.ok(
    invocation.env.PATH?.startsWith("/opt/homebrew/bin:/usr/bin:/bin:"),
  );
});

test("slack-cli Path が .js なら、Node Path の node で動かし、JS を先頭の引数にする。PATH の先頭は node のフォルダ（JS のフォルダではない）", () => {
  const invocation = invocationOf(
    ["channels", "--format", "json"],
    {
      slackCliPath: SCRIPT,
      nodePath: "/opt/custom/bin/node",
      slackCliProfile: "",
    },
    [SCRIPT, "/opt/custom/bin/node", VOLTA_NODE],
  );
  assert.equal(invocation.command, "/opt/custom/bin/node");
  assert.deepEqual(invocation.args, [SCRIPT, "channels", "--format", "json"]);
  assert.equal(
    invocation.env.PATH,
    "/opt/custom/bin:/usr/bin:/bin:/usr/local/bin",
  );
});

test(".js で Node Path が空なら、同じ順（volta・homebrew・/usr/local/bin）に node を探す", () => {
  const settings = { ...noSettings, slackCliPath: SCRIPT };
  assert.equal(
    invocationOf([], settings, [SCRIPT, LOCAL_NODE, BREW_NODE, VOLTA_NODE])
      .command,
    VOLTA_NODE,
  );
  assert.equal(
    invocationOf([], settings, [SCRIPT, LOCAL_NODE, BREW_NODE]).command,
    BREW_NODE,
  );
  const invocation = invocationOf([], settings, [SCRIPT, LOCAL_NODE]);
  assert.equal(invocation.command, LOCAL_NODE);
  assert.deepEqual(invocation.args, [SCRIPT]);
  assert.ok(invocation.env.PATH?.startsWith("/usr/local/bin:/usr/bin:/bin:"));
});

test("~ で始まる値はホームに展開する（slack-cli Path・Node Path とも）。展開後が相対パスなら、実行するホームからの相対にする", () => {
  const home = invocationOf(
    ["x"],
    {
      slackCliPath: "~/slack-cli/dist/index.js",
      nodePath: "~/.volta/bin/node",
      slackCliProfile: "",
    },
    [SCRIPT, VOLTA_NODE],
  );
  assert.equal(home.command, VOLTA_NODE);
  assert.deepEqual(home.args, [SCRIPT, "x"]);

  // ~ だけならホームそのもの（フォルダなので、実在のファイルではない。ここでは展開だけを見る）
  const { env, checked } = fakeEnv([]);
  buildInvocation([], { ...noSettings, slackCliPath: "~" }, env);
  assert.deepEqual(checked, [HOME]);

  // 相対パスは、cwd（ホーム）からの相対
  const relative = invocationOf(
    [],
    {
      ...noSettings,
      slackCliPath: "slack-cli/dist/index.js",
      nodePath: VOLTA_NODE,
    },
    [SCRIPT, VOLTA_NODE],
  );
  assert.deepEqual(relative.args, [SCRIPT]);
});

test("設定の値の前後の空白は取る。空白だけの値は、空と同じに決まった場所から探す", () => {
  const trimmed = invocationOf(
    [],
    {
      slackCliPath: `  ${SCRIPT}\n`,
      nodePath: ` ${VOLTA_NODE} `,
      slackCliProfile: "",
    },
    [SCRIPT, VOLTA_NODE],
  );
  assert.equal(trimmed.command, VOLTA_NODE);

  const blank = invocationOf(
    [],
    { slackCliPath: "   ", nodePath: "", slackCliProfile: "  " },
    [BREW_CLI],
  );
  assert.equal(blank.command, BREW_CLI);
  assert.deepEqual(blank.args, []);
});

test("Profile があれば、引数の末尾に --profile <値> を付ける。空（空白だけ）なら付けない", () => {
  const withProfile = invocationOf(
    ["channels", "--format", "json"],
    { ...noSettings, slackCliProfile: " work " },
    [BREW_CLI],
  );
  assert.deepEqual(withProfile.args, [
    "channels",
    "--format",
    "json",
    "--profile",
    "work",
  ]);

  // .js のときも、末尾（JS と引数のあと）
  const script = invocationOf(
    ["whoami"],
    {
      slackCliPath: SCRIPT,
      nodePath: VOLTA_NODE,
      slackCliProfile: "work",
    },
    [SCRIPT, VOLTA_NODE],
  );
  assert.deepEqual(script.args, [SCRIPT, "whoami", "--profile", "work"]);

  for (const blank of ["", "  "]) {
    const without = invocationOf(
      ["whoami"],
      { ...noSettings, slackCliProfile: blank },
      [BREW_CLI],
    );
    assert.ok(!without.args.includes("--profile"));
  }
});

test("slack-cli が見つからないときは、例外でなく失敗の値を返す：決まった場所のどこにも無いとき、探した場所を順に持つ", () => {
  const { env, checked } = fakeEnv([]);
  const result = buildInvocation(["x"], noSettings, env);
  assert.deepEqual(result, {
    kind: "missing",
    missing: {
      target: "slack-cli",
      configured: undefined,
      searched: [VOLTA_CLI, BREW_CLI, LOCAL_CLI],
    },
  });
  assert.deepEqual(checked, [VOLTA_CLI, BREW_CLI, LOCAL_CLI]);
});

test("slack-cli が見つからないときは、指定したパスに無いなら、そのパスだけを調べて失敗の値を返す（決まった場所は探さない）", () => {
  const { env, checked } = fakeEnv([BREW_CLI, VOLTA_CLI]);
  const result = buildInvocation(
    [],
    { ...noSettings, slackCliPath: "~/missing/slack-cli" },
    env,
  );
  assert.deepEqual(result, {
    kind: "missing",
    missing: {
      target: "slack-cli",
      configured: `${HOME}/missing/slack-cli`,
      searched: [`${HOME}/missing/slack-cli`],
    },
  });
  assert.deepEqual(checked, [`${HOME}/missing/slack-cli`]);
});

test(".js で node が見つからないときも、失敗の値を返す：指定したパスに無いとき・決まった場所のどこにも無いとき", () => {
  const specified = buildInvocation(
    [],
    { slackCliPath: SCRIPT, nodePath: "~/nope/node", slackCliProfile: "" },
    fakeEnv([SCRIPT, VOLTA_NODE]).env,
  );
  assert.deepEqual(specified, {
    kind: "missing",
    missing: {
      target: "node",
      configured: `${HOME}/nope/node`,
      searched: [`${HOME}/nope/node`],
    },
  });

  const searched = buildInvocation(
    [],
    { ...noSettings, slackCliPath: SCRIPT },
    fakeEnv([SCRIPT]).env,
  );
  assert.deepEqual(searched, {
    kind: "missing",
    missing: {
      target: "node",
      configured: undefined,
      searched: [VOLTA_NODE, BREW_NODE, LOCAL_NODE],
    },
  });
});

test("slack-cli も node も無いときは、先に slack-cli が見つからない失敗を返す。.js でなければ、node は要らない", () => {
  const both = buildInvocation(
    [],
    { ...noSettings, slackCliPath: SCRIPT },
    fakeEnv([]).env,
  );
  assert.equal(both.kind === "missing" && both.missing.target, "slack-cli");

  // node が無くても、.js でない slack-cli は動かせる
  assert.equal(invocationOf([], noSettings, [BREW_CLI]).command, BREW_CLI);
});

test("見つからなかったときの run のエラーは、起動できなかったときの形（ENOENT・spawn）。送信は、この形を「何も送っていない失敗」として扱う", async () => {
  const missing = {
    target: "slack-cli" as const,
    configured: undefined,
    searched: [VOLTA_CLI, BREW_CLI],
  };
  const error = missingError(missing);
  assert.equal(error.code, "ENOENT");
  assert.ok(error.syscall?.startsWith("spawn"));
  assert.ok(error.message.includes("slack-cli が見つかりません"));
  assert.ok(error.message.includes(BREW_CLI));

  const run = createRun(noSettings, () => fakeEnv([]).env);
  await assert.rejects(run([], { timeoutMs: 1_000 }), { code: "ENOENT" });
});

test("シンボリックリンクは辿らない：動かすのも PATH に足すのも、設定のパスのまま。リンク切れは無いものとして扱う", async () => {
  await withTempDir(async (dir) => {
    // dir/lib/index.js が実体、dir/bin/slack-cli がそれへのリンク（Homebrew の bin と同じ形）
    await mkdir(join(dir, "lib"));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "lib", "index.js"), "");
    const link = join(dir, "bin", "slack-cli");
    await symlink(join(dir, "lib", "index.js"), link);
    const broken = join(dir, "bin", "broken");
    await symlink(join(dir, "lib", "gone.js"), broken);

    const env: LaunchEnv = {
      home: dir,
      baseEnv: { PATH: "/usr/local/bin" },
      exists: isFile,
    };
    const result = buildInvocation(
      [],
      { ...noSettings, slackCliPath: link },
      env,
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      // リンクのまま（実体の lib/index.js ではない）。PATH に足すのも、リンクのあるフォルダ
      assert.equal(result.invocation.command, link);
      assert.equal(
        result.invocation.env.PATH,
        `${dirname(link)}:/usr/bin:/bin:/usr/local/bin`,
      );
    }
    assert.equal(
      buildInvocation([], { ...noSettings, slackCliPath: broken }, env).kind,
      "missing",
    );
    // フォルダは、ファイルではない
    assert.equal(isFile(dir), false);
  });
});

test("設定の値で slack-cli を動かす：JS を node で動かし、引数のあとに --profile を付け、ホームから実行する（Slack は呼ばない）", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "echo-args.js");
    await writeFile(
      script,
      "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));",
    );
    const run = createRun(
      {
        slackCliPath: script,
        nodePath: process.execPath,
        slackCliProfile: "p1",
      },
      () => ({ home: dir, baseEnv: process.env, exists: isFile }),
    );
    const result = await run(["whoami", "--format", "json"], {
      timeoutMs: 10_000,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["whoami", "--format", "json", "--profile", "p1"],
      cwd: realpathSync(dir),
    });
  });
});

// ---- 実行 ---------------------------------------------------------------------

test("終了コード・標準出力・標準エラーを返す", async () => {
  const result = await runProcess(
    plainNode("-e", "console.log('日本語'); console.error('警告')"),
    { timeoutMs: 10_000 },
  );
  assert.deepEqual(result, {
    code: 0,
    signal: null,
    stdout: "日本語\n",
    stderr: "警告\n",
    timedOut: false,
    aborted: false,
  });
});

test("0 以外の終了コードをそのまま返す", async () => {
  const result = await runProcess(
    plainNode("-e", "console.error('✗ Error: x'); process.exit(3)"),
    { timeoutMs: 10_000 },
  );
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "✗ Error: x\n");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("大きな出力でも、日本語の文字が chunk の境目で割れない", async () => {
  // 3 バイトの文字を 10 万個。pipe の chunk（64KB）は 3 の倍数でないので、chunk ごとに文字にすると割れる
  const result = await runProcess(
    plainNode("-e", "process.stdout.write('あ'.repeat(100000))"),
    { timeoutMs: 20_000 },
  );
  assert.equal(result.stdout, "あ".repeat(100000));
});

test("標準出力が上限を超えたら止めて、エラーにする", async () => {
  await assert.rejects(
    runProcess(
      plainNode(
        "-e",
        "process.stdout.write('x'.repeat(100000)); setTimeout(()=>{},60000)",
      ),
      { timeoutMs: 20_000, maxBuffer: 1000 },
    ),
    /上限/,
  );
});

test("起動できないコマンドは reject する", async () => {
  await assert.rejects(
    runProcess(
      {
        command: "/nonexistent/command",
        args: [],
        cwd: process.cwd(),
        env: process.env,
      },
      { timeoutMs: 10_000 },
    ),
    { code: "ENOENT" },
  );
});

test("起動する前に中断されていたら、何も起動せず中断として返す", async () => {
  const controller = new AbortController();
  controller.abort();
  // 起動していれば ENOENT で reject するコマンド。resolve すれば、起動していない
  const result = await runProcess(
    {
      command: "/nonexistent/command",
      args: [],
      cwd: process.cwd(),
      env: process.env,
    },
    { timeoutMs: 10_000, signal: controller.signal },
  );
  assert.deepEqual(result, {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: true,
  });
});

test(
  "時間切れで止めた結果は timedOut になる（volta を通さない node）",
  { timeout: 20_000 },
  async () => {
    const marker = `slack-hub-test-${randomUUID()}`;
    const result = await runProcess(
      plainNode("-e", "setTimeout(()=>{},60000)", marker),
      { timeoutMs: 800 },
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGTERM");
    assert.ok(await waitUntil(() => countProcesses(marker) === 0, 3_000));
  },
);

test(
  "中断した結果は aborted になる（volta を通さない node）",
  { timeout: 20_000 },
  async () => {
    const marker = `slack-hub-test-${randomUUID()}`;
    const controller = new AbortController();
    const running = runProcess(
      plainNode("-e", "setTimeout(()=>{},60000)", marker),
      { timeoutMs: 30_000, signal: controller.signal },
    );
    try {
      assert.ok(await waitUntil(() => countProcesses(marker) >= 1, 5_000));
    } finally {
      controller.abort();
    }
    const result = await running;
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.ok(await waitUntil(() => countProcesses(marker) === 0, 3_000));
  },
);

test("正常に終わった結果には、あとから届いた中断が効かない", async () => {
  const controller = new AbortController();
  const result = await runProcess(plainNode("-e", "console.log('ok')"), {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(result.code, 0);
  assert.equal(result.aborted, false);
});

// ---- 子のプロセスが残らないこと（AC-1-04） -------------------------------------------
//
// ~/.volta/bin/node は volta の shim で、時間切れの SIGTERM を子の node に伝えない。
// 本番と同じ呼び出し（buildInvocation の command と cwd・env）で、眠るだけの node を動かし、
// 止めたあとに子が残っていないことを ps で確かめる。Slack は呼ばない

// ~/.volta/bin/node（volta の shim）を明示した呼び方。本番と同じ組み立て（buildInvocation）で作る。
// slack-cli Path は .js にして、Node Path で shim を指す。JS のファイルは、このテストでは動かさない
// （眠るだけの node を、引数を替えて動かす）ので、ある・無いは問わない
const voltaShim = join(homedir(), ".volta", "bin", "node");
const shimBuild = buildInvocation(
  [],
  {
    slackCliPath: "~/slack-cli/dist/index.js",
    nodePath: voltaShim,
    slackCliProfile: "",
  },
  { home: homedir(), baseEnv: process.env, exists: () => true },
);
if (shimBuild.kind !== "ok") assert.fail("shim の呼び方を組めませんでした");
const base: Invocation = shimBuild.invocation;
// Voltaを使う環境だけで追加の統合テストを実行する。通常のnode経由は別のテストで確認する
const hasVolta =
  existsSync(base.command) && existsSync(join(homedir(), ".volta"));

// 印を持つプロセスの内訳。shim（~/.volta/bin/node）と、その下で動く本物の node。
// 印は shim の引数にも入るので、数が1以上というだけでは、shim だけが動いている段階（子が起動する前）と見分けられない。
// 子のコマンドラインは shim のパスで始まらない（先頭が node になる）ので、それで見分ける
function markedProcesses(marker: string): { shim: number; child: number } {
  const commands = markedCommands(marker);
  const shim = commands.filter(
    (command) =>
      command === base.command || command.startsWith(`${base.command} `),
  ).length;
  return { shim, child: commands.length - shim };
}

// 止める直前の内訳をテストの出力に残す。子が動いてから止めたことを、あとから確かめられるようにする
const describeBeforeStop = (marker: string, waitStart: number): string => {
  const seen = markedProcesses(marker);
  return `止める前に見えた印つきのプロセス: shim ${seen.shim}・子の node ${seen.child}（待ち始めてから ${Date.now() - waitStart} ミリ秒）`;
};

// 眠るだけの node。印は、このテストの node だけを ps で見分けるための一意な引数
const sleeper = (marker: string): Invocation => ({
  ...base,
  args: ["-e", "setTimeout(()=>{},60000)", marker],
});

// shim 経由で動かす node のスクリプト。files は、スクリプトが process.argv.slice(1) の先頭から受け取るファイルのパス
// （準備ができた・SIGTERM を受けた・後始末が済んだ、を知らせるのに使う）。印は最後の引数
const scripted = (
  script: string,
  marker: string,
  ...files: string[]
): Invocation => ({ ...base, args: ["-e", script, ...files, marker] });

// SIGTERM を受けても終わらない子。SIGTERM の受け方を決めたら ready を書き、SIGTERM を受けたら term を書く
const IGNORE_SIGTERM = `
  const fs = require("fs");
  const [readyFile, termFile] = process.argv.slice(1);
  process.on("SIGTERM", () => fs.writeFileSync(termFile, "term"));
  fs.writeFileSync(readyFile, "ready");
  setTimeout(() => {}, 60000);
`;

// SIGTERM を受けたら、後始末に 300 ミリ秒かけて cleaned を書き、終わる子（slack-cli の status がこの形）
const CLEAN_UP_ON_SIGTERM = `
  const fs = require("fs");
  const [readyFile, cleanedFile] = process.argv.slice(1);
  process.on("SIGTERM", () => {
    setTimeout(() => {
      fs.writeFileSync(cleanedFile, "cleaned");
      process.exit(0);
    }, 300);
  });
  fs.writeFileSync(readyFile, "ready");
  setTimeout(() => {}, 60000);
`;

// 一時ファイルを置くフォルダを作り、終わったら消す
async function withTempDir(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "slack-hub-test-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 止めたあと、子が消えるのを待つ時間。グループに SIGTERM を送れば数ミリ秒で消える
const SETTLE_MS = 800;

test(
  "volta の shim 経由でも、時間切れで止めると子の node が残らない",
  {
    skip: !hasVolta && "volta が無いので、shim 経由の確認はできない",
    timeout: 30_000,
  },
  async (t) => {
    const marker = `slack-hub-test-${randomUUID()}`;
    const running = runProcess(sleeper(marker), { timeoutMs: 3_000 });
    // 止める前に、shim の下の本物の node が動いていることを確かめる。
    // shim だけが動いている段階では、止めたあとに残っていないことは何の証拠にもならない
    const waitStart = Date.now();
    const started = await waitUntil(
      () => markedProcesses(marker).child >= 1,
      2_500,
    );
    t.diagnostic(describeBeforeStop(marker, waitStart));
    const result = await running;
    assert.ok(started, "止める前に、shim の下の眠る node が動いていなかった");
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    await sleep(SETTLE_MS);
    assert.equal(
      countProcesses(marker),
      0,
      "止めたあとに子の node が残っている",
    );
  },
);

test(
  "volta の shim 経由でも、AbortSignal で中断すると子の node が残らない",
  {
    skip: !hasVolta && "volta が無いので、shim 経由の確認はできない",
    timeout: 30_000,
  },
  async (t) => {
    const marker = `slack-hub-test-${randomUUID()}`;
    const controller = new AbortController();
    const running = runProcess(sleeper(marker), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    // 中断する前に、shim の下の本物の node が動いていることを確かめる（時間切れのテストと同じ）
    const waitStart = Date.now();
    let started = false;
    try {
      started = await waitUntil(
        () => markedProcesses(marker).child >= 1,
        5_000,
      );
      t.diagnostic(describeBeforeStop(marker, waitStart));
    } finally {
      controller.abort();
    }
    const result = await running;
    assert.ok(started, "中断する前に、shim の下の眠る node が動いていなかった");
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    await sleep(SETTLE_MS);
    assert.equal(
      countProcesses(marker),
      0,
      "中断したあとに子の node が残っている",
    );
  },
);

test(
  "volta の shim 経由で、SIGTERM を受けても終わらない子も、止めたあとに残らない",
  {
    skip: !hasVolta && "volta が無いので、shim 経由の確認はできない",
    timeout: 30_000,
  },
  async () => {
    await withTempDir(async (dir) => {
      const marker = `slack-hub-test-${randomUUID()}`;
      const readyFile = join(dir, "ready");
      const termFile = join(dir, "term");
      const controller = new AbortController();
      const running = runProcess(
        scripted(IGNORE_SIGTERM, marker, readyFile, termFile),
        { timeoutMs: 30_000, signal: controller.signal },
      );
      // 子が SIGTERM の受け方を決めてから中断する（決める前だと、SIGTERM の既定の動きで終わってしまう）
      const ready = await waitUntil(() => existsSync(readyFile), 5_000);
      controller.abort();
      const result = await running;
      assert.ok(ready, "中断する前に、子の準備ができていなかった");
      assert.equal(result.aborted, true);
      // 子は SIGTERM を受けた。それでも終わらなかったので、残っていなければ SIGKILL で止められている
      assert.ok(existsSync(termFile), "子に SIGTERM が届いていない");
      assert.ok(
        await waitUntil(() => countProcesses(marker) === 0, SETTLE_MS),
        "SIGTERM を無視した子の node が残っている",
      );
    });
  },
);

test(
  "volta の shim 経由で、SIGTERM を受けて後始末する子は、後始末が済むまで待ってから結果を返す",
  {
    skip: !hasVolta && "volta が無いので、shim 経由の確認はできない",
    timeout: 30_000,
  },
  async () => {
    await withTempDir(async (dir) => {
      const marker = `slack-hub-test-${randomUUID()}`;
      const readyFile = join(dir, "ready");
      const cleanedFile = join(dir, "cleaned");
      const controller = new AbortController();
      const running = runProcess(
        scripted(CLEAN_UP_ON_SIGTERM, marker, readyFile, cleanedFile),
        { timeoutMs: 30_000, signal: controller.signal },
      );
      const ready = await waitUntil(() => existsSync(readyFile), 5_000);
      controller.abort();
      const result = await running;
      assert.ok(ready, "中断する前に、子の準備ができていなかった");
      assert.equal(result.aborted, true);
      // shim は SIGTERM ですぐ終わる。その時点で結果を返したり、子に SIGKILL を送ったりすると、
      // 子の後始末が済む前になる。結果が返った時点で、後始末は済んでいる（猶予のあいだは待つ）
      assert.ok(existsSync(cleanedFile), "子の後始末が済む前に、結果が返った");
      assert.ok(
        await waitUntil(() => countProcesses(marker) === 0, SETTLE_MS),
        "子の node が残っている",
      );
    });
  },
);

// ---- 失敗の文 ------------------------------------------------------------------

const result = (overrides: Partial<CliResult>): CliResult => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

test("画面に出す失敗の文は、時間切れ・中断・エラー文を見分ける", () => {
  assert.equal(
    failureMessage(result({ code: null, timedOut: true }), 120_000),
    "slack-cli が 120 秒以内に終わらず止めました",
  );
  assert.equal(
    failureMessage(result({ code: null, aborted: true }), 120_000),
    "slack-cli の呼び出しを中断しました",
  );
  assert.equal(
    failureMessage(
      result({ stderr: "✗ Error: An API error occurred: invalid_auth\n" }),
      120_000,
    ),
    "An API error occurred: invalid_auth",
  );
});
