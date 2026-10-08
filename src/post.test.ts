import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { composeMarkdown } from "./compose.ts";
import { toBlocks, toText } from "./md-to-blocks.ts";
import {
  postMarkdown,
  SEND_DIR_PREFIX,
  STALE_SEND_DIR_MS,
  type SendRunner,
} from "./post.ts";
import { runProcess } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// このテストは Slack を呼ばない。slack-cli を呼ぶ部分（run）を、記録するだけの関数に差し替える

// ワークスペースの ID（テスト用のダミー）。投稿の位置を開くリンクに入る
const TEAM = "T0000000012";

const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

const sentJson = (channelId: string, ts = "1759560123.456789") =>
  JSON.stringify({ ok: true, channelId, ts, threadTs: null }, null, 2);

// Node が実際に返す、起動できなかったときのエラー（ENOENT）。作り物のエラーでなく、本物の形で確かめる
function realSpawnError(): Promise<Error> {
  return new Promise((resolve) => {
    spawn("/nonexistent/command", []).on("error", resolve);
  });
}

// 一時ファイルを置くフォルダを作り、終わったら消す
async function withRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "slack-hub-post-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Seen = { args: string[]; blocks: unknown; text: string; dir: string };

// 呼ばれた引数と、そのときの一時ファイルの中身を記録する。respond が Error を返したら、その Error を投げる
function recorder(respond: (args: string[]) => CliResult | Error) {
  const seen: Seen[] = [];
  const run: SendRunner = async (args) => {
    const blocksFile = args[args.indexOf("--blocks-file") + 1];
    const textFile = args[args.indexOf("-f") + 1];
    seen.push({
      args,
      blocks: JSON.parse(await readFile(blocksFile, "utf8")),
      text: await readFile(textFile, "utf8"),
      dir: dirname(blocksFile),
    });
    const response = respond(args);
    if (response instanceof Error) throw response;
    return response;
  };
  return { seen, run };
}

test("会話宛て：-c で送り、メンションが先頭に付いた本文を blocks と通知用の文字にして渡す", async () => {
  await withRoot(async (root) => {
    const { seen, run } = recorder(() =>
      cliResult({ stdout: sentJson("C0000000001") }),
    );
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C0000000001" },
      mentionIds: ["U0000000013"],
      markdown: "お疲れさまです",
      tmpRoot: root,
      run,
    });

    assert.deepEqual(outcome, {
      kind: "sent",
      channelId: "C0000000001",
      ts: "1759560123.456789",
      threadTs: null,
      link: "slack://channel?team=T0000000012&id=C0000000001&message=1759560123.456789",
    });
    assert.equal(seen.length, 1);
    const { args, blocks, text } = seen[0];
    // send -c <会話ID> --blocks-file … -f … --format json
    assert.deepEqual(args.slice(0, 3), ["send", "-c", "C0000000001"]);
    assert.equal(args[3], "--blocks-file");
    assert.equal(args[5], "-f");
    assert.deepEqual(args.slice(-2), ["--format", "json"]);
    assert.ok(!args.includes("--user-id"));
    // 先頭に自分へのメンションが付く
    const expected = composeMarkdown(["U0000000013"], "お疲れさまです");
    assert.deepEqual(blocks, toBlocks(expected));
    assert.deepEqual((blocks as unknown[])[0], {
      type: "section",
      text: { type: "mrkdwn", text: "<@U0000000013>" },
    });
    assert.equal(text, toText(expected));
    assert.ok(text.startsWith("<@U0000000013>"));
  });
});

test("人宛て：--user-id で送り、返った DM の会話 ID（D…）をそのまま返す", async () => {
  await withRoot(async (root) => {
    const { seen, run } = recorder(() =>
      cliResult({ stdout: sentJson("D0000000009") }),
    );
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "person", id: "U0000000015" },
      mentionIds: [],
      markdown: "こんにちは",
      tmpRoot: root,
      run,
    });

    assert.equal(outcome.kind, "sent");
    if (outcome.kind === "sent") assert.equal(outcome.channelId, "D0000000009");
    const { args } = seen[0];
    assert.deepEqual(args.slice(0, 3), ["send", "--user-id", "U0000000015"]);
    assert.ok(!args.includes("-c"));
    assert.deepEqual(args.slice(-2), ["--format", "json"]);
  });
});

test("スレッドへの返信：-t <スレッドの親の ts> を付けて送り、届いたら、スレッドの中の返信を開くリンクを返す", async () => {
  await withRoot(async (root) => {
    const parentTs = "1759560000.000100";
    const { seen, run } = recorder(() =>
      cliResult({
        stdout: JSON.stringify(
          {
            ok: true,
            channelId: "C0000000001",
            ts: "1759560300.000300",
            // slack-cli は、渡された -t をそのまま threadTs として返す
            threadTs: parentTs,
          },
          null,
          2,
        ),
      }),
    );
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C0000000001" },
      mentionIds: [],
      markdown: "了解です",
      tmpRoot: root,
      threadTs: parentTs,
      run,
    });

    assert.deepEqual(outcome, {
      kind: "sent",
      channelId: "C0000000001",
      ts: "1759560300.000300",
      threadTs: parentTs,
      link: `slack://channel?team=T0000000012&id=C0000000001&message=1759560300.000300&thread_ts=${parentTs}`,
    });
    const { args } = seen[0];
    assert.equal(args[args.indexOf("-t") + 1], parentTs);
    assert.deepEqual(args.slice(-4), ["-t", parentTs, "--format", "json"]);
    assert.deepEqual(args.slice(0, 3), ["send", "-c", "C0000000001"]);
  });
});

test("スレッドの指定が無い送信には、-t を付けない", async () => {
  await withRoot(async (root) => {
    const { seen, run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
    await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run,
    });
    assert.ok(!seen[0].args.includes("-t"));
  });
});

test("メンションが無いときは、本文だけを変換して渡す", async () => {
  await withRoot(async (root) => {
    const { seen, run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
    await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "- 項目1\n- 項目2",
      tmpRoot: root,
      run,
    });
    assert.deepEqual(seen[0].blocks, toBlocks("- 項目1\n- 項目2"));
    assert.equal(seen[0].text, toText("- 項目1\n- 項目2"));
  });
});

test("一時ファイルは、届いたとき・失敗のとき・未確認のとき、どれでも送信のあとに消える", async () => {
  const cases: [string, CliResult][] = [
    ["届いた", cliResult({ stdout: sentJson("C1") })],
    [
      "失敗",
      cliResult({
        code: 1,
        stderr: "✗ Error: An API error occurred: channel_not_found\n",
      }),
    ],
    [
      "未確認（時間切れ）",
      cliResult({ code: null, signal: "SIGTERM", timedOut: true }),
    ],
  ];
  for (const [label, response] of cases) {
    await withRoot(async (root) => {
      const { seen, run } = recorder(() => response);
      await postMarkdown({
        teamId: TEAM,
        target: { kind: "conversation", id: "C1" },
        mentionIds: [],
        markdown: "本文",
        tmpRoot: root,
        run,
      });
      // 送信中は、一時ファイルがあった
      assert.equal(seen.length, 1, label);
      // 送信のあとは、一時フォルダごと無い
      assert.ok(!existsSync(seen[0].dir), `${label}: 一時フォルダが残っている`);
      assert.deepEqual(await readdir(root), [], label);
    });
  }
});

test("結果の分類をそのまま返す：Slack が断ったら失敗、時間切れと通信の失敗は未確認", async () => {
  await withRoot(async (root) => {
    const post = (response: CliResult) =>
      postMarkdown({
        teamId: TEAM,
        target: { kind: "conversation", id: "C1" },
        mentionIds: [],
        markdown: "本文",
        tmpRoot: root,
        run: recorder(() => response).run,
      });

    assert.deepEqual(
      await post(
        cliResult({
          code: 1,
          stderr: "✗ Error: An API error occurred: channel_not_found\n",
        }),
      ),
      { kind: "failed", message: "An API error occurred: channel_not_found" },
    );
    const timeout = await post(
      cliResult({ code: null, signal: "SIGTERM", timedOut: true }),
    );
    assert.equal(timeout.kind, "unconfirmed");
    const request = await post(
      cliResult({
        code: 1,
        stderr: "✗ Error: A request error occurred: socket hang up\n",
      }),
    );
    assert.equal(request.kind, "unconfirmed");
  });
});

test("slack-cli を起動できなかったときは、投げずに失敗として返し、一時ファイルを消す", async () => {
  await withRoot(async (root) => {
    const spawnError = await realSpawnError();
    const { seen, run } = recorder(() => spawnError);
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run,
    });
    // 起動できなかったので、Slack には何も送っていない
    assert.deepEqual(outcome, {
      kind: "failed",
      message: "spawn /nonexistent/command ENOENT",
    });
    assert.ok(!existsSync(seen[0].dir));
    assert.deepEqual(await readdir(root), []);
  });
});

test("slack-cli を起動したあとの失敗（出力が上限を超えた）は、失敗でなく未確認として返し、一時ファイルを消す", async () => {
  await withRoot(async (root) => {
    // 本物の runProcess で、起動したあとに reject する状況を作る（send ではなく、出力して眠るだけの node）
    const run: SendRunner = () =>
      runProcess(
        {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('x'.repeat(100000)); setTimeout(()=>{},60000)",
          ],
          cwd: process.cwd(),
          env: process.env,
        },
        { timeoutMs: 20_000, maxBuffer: 1000 },
      );
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run,
    });
    // 起動したあとなので、Slack に届いている可能性がある。失敗と出すと、送り直しで二重に投稿される
    assert.equal(outcome.kind, "unconfirmed");
    if (outcome.kind === "unconfirmed") {
      assert.equal(outcome.reason, "process_error");
      assert.ok(outcome.message.includes("上限"));
      assert.ok(outcome.message.includes("届いている可能性"));
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test("一時ファイルを置くフォルダが無ければ作る", async () => {
  await withRoot(async (root) => {
    const tmpRoot = join(root, "not-yet", "support");
    const { seen, run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot,
      run,
    });
    assert.equal(outcome.kind, "sent");
    assert.equal(dirname(seen[0].dir), tmpRoot);
    assert.deepEqual(await readdir(tmpRoot), []);
  });
});

test("同時に2つ送っても、一時ファイルを取り合わない", async () => {
  await withRoot(async (root) => {
    const { seen, run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
    const post = (markdown: string) =>
      postMarkdown({
        teamId: TEAM,
        target: { kind: "conversation", id: "C1" },
        mentionIds: [],
        markdown,
        tmpRoot: root,
        run,
      });
    const [a, b] = await Promise.all([post("一つ目"), post("二つ目")]);
    assert.equal(a.kind, "sent");
    assert.equal(b.kind, "sent");
    assert.notEqual(seen[0].dir, seen[1].dir);
    assert.deepEqual(
      seen.map((s) => s.text).sort(),
      [toText("一つ目"), toText("二つ目")].sort(),
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("一時フォルダを作れないときは、slack-cli を呼ばずに失敗として返す", async () => {
  await withRoot(async (root) => {
    // フォルダを置くはずの場所に、ファイルがある
    const tmpRoot = join(root, "occupied");
    await writeFile(tmpRoot, "ファイル");
    let called = false;
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot,
      run: async () => {
        called = true;
        return cliResult({ stdout: sentJson("C1") });
      },
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(called, false);
  });
});

test("送ったあとの一時フォルダの削除に失敗しても、届いた結果をそのまま返す", async () => {
  await withRoot(async (root) => {
    const run: SendRunner = async () => {
      // 親のフォルダを書き込み禁止にして、あとの削除を失敗させる
      await chmod(root, 0o500);
      return cliResult({ stdout: sentJson("C1") });
    };
    try {
      const outcome = await postMarkdown({
        teamId: TEAM,
        target: { kind: "conversation", id: "C1" },
        mentionIds: [],
        markdown: "本文",
        tmpRoot: root,
        run,
      });
      // 届いた投稿を失敗と出すと、送り直しで二重に投稿される
      assert.equal(outcome.kind, "sent");
    } finally {
      await chmod(root, 0o700);
    }
  });
});

test("送信の前に、10分より古い send-* のフォルダだけを消す", async () => {
  await withRoot(async (root) => {
    const stale = join(root, "send-aaaaaa");
    // 9分前。送信中のものかもしれないので消さない
    const recent = join(root, "send-bbbbbb");
    // 前置きは同じでも、mkdtemp が付ける6文字の乱数の名前でない
    const otherName = join(root, "send-notes");
    // 名前は合っているが、フォルダでなくファイル
    const file = join(root, "send-cccccc");
    const prefs = join(root, "prefs.json");
    for (const dir of [stale, recent, otherName]) {
      await mkdir(dir);
      await writeFile(join(dir, "text.txt"), "本文");
    }
    await writeFile(file, "ファイル");
    await writeFile(prefs, "{}");
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000);
    // 11分前（しきい値より古い）にするもの。消えるのは stale だけ
    for (const path of [stale, otherName, file, prefs]) {
      await utimes(path, minutesAgo(11), minutesAgo(11));
    }
    await utimes(recent, minutesAgo(9), minutesAgo(9));
    assert.equal(STALE_SEND_DIR_MS, 10 * 60_000);

    const { run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run,
    });

    assert.equal(outcome.kind, "sent");
    assert.deepEqual((await readdir(root)).sort(), [
      "prefs.json",
      "send-bbbbbb",
      "send-cccccc",
      "send-notes",
    ]);
  });
});

test("送信が実際に作るフォルダの名前（mkdtemp の乱数付き）のものは、11分前になっていれば、次の送信の前に消える", async () => {
  await withRoot(async (root) => {
    // 掃除の照合に合う名前を手で書かず、送信と同じ前置きで mkdtemp に作らせる（名前の照合が実際の名前に合うことを確かめる）
    const abandoned = await mkdtemp(join(root, SEND_DIR_PREFIX));
    await writeFile(join(abandoned, "text.txt"), "本文");
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
    await utimes(abandoned, elevenMinutesAgo, elevenMinutesAgo);

    // 送信している間に、もう消えている（送信のあとに消えたのではない）
    let existedDuringSend: boolean | undefined;
    const run: SendRunner = async () => {
      existedDuringSend = existsSync(abandoned);
      return cliResult({ stdout: sentJson("C1") });
    };
    const outcome = await postMarkdown({
      teamId: TEAM,
      target: { kind: "conversation", id: "C1" },
      mentionIds: [],
      markdown: "本文",
      tmpRoot: root,
      run,
    });

    assert.equal(outcome.kind, "sent");
    assert.equal(existedDuringSend, false);
    // この送信の一時フォルダも消えているので、何も残らない
    assert.deepEqual(await readdir(root), []);
  });
});

test("古い一時フォルダを掃除できなくても、送信は止めない", async () => {
  await withRoot(async (root) => {
    // 読めないフォルダにして、掃除（一覧の取得）を失敗させる。書き込みと辿りは許すので、一時フォルダは作れる
    await chmod(root, 0o300);
    try {
      await assert.rejects(readdir(root), { code: "EACCES" });
      const { run } = recorder(() => cliResult({ stdout: sentJson("C1") }));
      const outcome = await postMarkdown({
        teamId: TEAM,
        target: { kind: "conversation", id: "C1" },
        mentionIds: [],
        markdown: "本文",
        tmpRoot: root,
        run,
      });
      assert.equal(outcome.kind, "sent");
    } finally {
      await chmod(root, 0o700);
    }
    assert.deepEqual(await readdir(root), []);
  });
});
