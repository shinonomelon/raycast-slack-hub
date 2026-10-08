// slack-cli の呼び出し。@raycast/api を読み込まないので、node のテストから動かせる
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cliErrorText } from "./cli-output.ts";
// 型だけを読む。値として読むと、設定を読む @raycast/api がテストの読み込みに連鎖する
import type { Settings } from "./settings.ts";
import type { CliResult } from "./types.ts";

export type Invocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

// 設定のうち、slack-cli の呼び方を決める3つ
export type CliSettings = Pick<
  Settings,
  "slackCliPath" | "nodePath" | "slackCliProfile"
>;

// 呼び方を組むのに使う、実行環境の値。テストでは差し替える
export type LaunchEnv = {
  home: string;
  baseEnv: NodeJS.ProcessEnv;
  // ファイルがあるか
  exists: (path: string) => boolean;
};

// 見つからなかったもの
export type CliMissing = {
  target: "slack-cli" | "node";
  // 設定で指定されたパス（~ とホームからの相対を展開したもの）。指定が無く、決まった場所から探したときは undefined
  configured: string | undefined;
  // 探した場所。指定があるときは、そのパスだけ
  searched: string[];
};

// 呼び方を組んだ結果。見つからないときは、例外にせず、何が見つからなかったかを値で返す
// （画面は、その理由を設定の直し方と一緒に出す）
export type BuildResult =
  | { kind: "ok"; invocation: Invocation }
  | { kind: "missing"; missing: CliMissing };

// 設定が空のときに、slack-cli と node を探すフォルダ。この順に探し、最初に見つかったものを使う
export const searchDirs = (home: string): string[] => [
  join(home, ".volta", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

// ~ で始まる値をホームに展開する（~ だけ、または ~/ で始まるものだけ。~名前 は展開しない）
function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

type Located = { path: string } | { missing: CliMissing };

// 動かすファイルの場所を決める。設定に値があればそのパスだけを調べ（展開後が相対なら、実行するホームからの相対）、
// 空なら決まった場所を順に探す。シンボリックリンクは辿らない（パスは、設定の値と探した場所のまま使う）
function locate(
  target: CliMissing["target"],
  configured: string,
  env: LaunchEnv,
): Located {
  const value = configured.trim();
  if (value !== "") {
    const path = resolve(env.home, expandHome(value, env.home));
    return env.exists(path)
      ? { path }
      : { missing: { target, configured: path, searched: [path] } };
  }
  const searched = searchDirs(env.home).map((dir) => join(dir, target));
  const path = searched.find((candidate) => env.exists(candidate));
  return path
    ? { path }
    : { missing: { target, configured: undefined, searched } };
}

// slack-cli を呼ぶ組み立て。
// - slack-cli Path が .js なら Node Path（空なら、決まった場所の node）で動かし、そうでなければ slack-cli そのものを動かす
// - Profile があれば、引数の末尾に --profile <値> を付ける。空なら付けない
// - Raycast は PATH が最小なので、動かすファイルのフォルダ（.js のときは node のフォルダ）を PATH の先頭に足す。
//   #!/usr/bin/env node が、同じフォルダの node を見つけられるようにするため。cwd は、volta の都合でホームのまま
export function buildInvocation(
  args: readonly string[],
  settings: CliSettings,
  env: LaunchEnv,
): BuildResult {
  const cli = locate("slack-cli", settings.slackCliPath, env);
  if ("missing" in cli) return { kind: "missing", missing: cli.missing };

  let command = cli.path;
  let leading: string[] = [];
  if (cli.path.endsWith(".js")) {
    const node = locate("node", settings.nodePath, env);
    if ("missing" in node) return { kind: "missing", missing: node.missing };
    command = node.path;
    leading = [cli.path];
  }
  const profile = settings.slackCliProfile.trim();
  return {
    kind: "ok",
    invocation: {
      command,
      args: [...leading, ...args, ...(profile ? ["--profile", profile] : [])],
      cwd: env.home,
      env: {
        ...env.baseEnv,
        PATH: [dirname(command), "/usr/bin", "/bin", env.baseEnv.PATH]
          .filter(Boolean)
          .join(":"),
      },
    },
  };
}

// ファイルがあるか。シンボリックリンクは辿った先を見る（Homebrew の bin はリンクなので、リンク切れは無いものとして扱う）
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// いまのマシンの実行環境
export const realEnv = (): LaunchEnv => ({
  home: homedir(),
  baseEnv: process.env,
  exists: isFile,
});

// 見つからなかったときに、run が返すエラー。起動できなかったときに Node が返すエラー（ENOENT・spawn）と同じ形にする。
// compose.ts はこの形のエラーを、何も送っていない失敗として扱う。形が違うと「送れたか未確認」になり、
// 送り直してよいのに、送り直しをためらわせてしまう
export function missingError(missing: CliMissing): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `${missing.target} が見つかりません（${missing.searched.join("・")}）`,
  );
  error.code = "ENOENT";
  error.syscall = `spawn ${missing.configured ?? missing.target}`;
  return error;
}

export type RunOptions = {
  // この時間で止める
  timeoutMs: number;
  // 中断する。止めるときはプロセスグループごと止める
  signal?: AbortSignal;
  // 標準出力の上限（バイト）。超えたら止めて、Error にする
  maxBuffer?: number;
};

// users の全件は数十 MB になりうるので、Open Channel と同じく大きく取る
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
// 標準エラーはエラー文しか出ないので、これ以上は読み捨てる
const STDERR_LIMIT = 1024 * 1024;
// SIGTERM のあと、この時間たっても終わらなければ SIGKILL で確実に止める
const KILL_GRACE_MS = 2_000;
// 止めたあと、先頭が終わった時点で、同じグループに子が残っていないかを調べる間隔
const GROUP_POLL_MS = 20;
// SIGKILL を送っても残っていたとき（終了待ちで固まったプロセスなど）に、結果を返すまで待つ上限
const KILL_SETTLE_MS = 1_000;

type StopReason = "timeout" | "abort" | "overflow";

// 子のプロセスを起動し、終了コード・標準出力・標準エラーと、時間切れか中断かを返す。
// 起動できなかったとき（コマンドが無いなど）と、標準出力が上限を超えたときは reject する。
//
// 時間切れ・中断のときは、プロセスグループごと SIGTERM で止める。spawn の timeout・signal は
// 直接の子にしか届かない。~/.volta/bin/node は volta の shim で、SIGTERM を子の node に伝えないため、
// それでは子の node が裏で動き続け、止めたはずの送信や検索が続いてしまう。
// detached で新しいプロセスグループにして、グループ全体に送ることで、shim の下の node まで止まる。
//
// 先頭（shim）は SIGTERM ですぐ終わるが、その下の node は SIGTERM を受けて後始末するか、無視することがある。
// そこで、先頭が終わっても、グループが空になるまで結果を返さない。猶予（KILL_GRACE_MS）を過ぎても
// 残っていれば SIGKILL を送る。SIGKILL の予約は、先頭が終わっても消さない
export function runProcess(
  invocation: Invocation,
  options: RunOptions,
): Promise<CliResult> {
  const { signal, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER } = options;
  // 起動する前に中断されていたら、何も起動しない
  if (signal?.aborted) {
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
    });
  }

  return new Promise<CliResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    // 日本語の名前が chunk の境目で割れないよう、集めてから1回で文字にする
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    let stopReason: StopReason | undefined;
    // 先頭のプロセスが終わったときの結果。出力の管（pipe）が閉じるのを待つ間に持っておく
    let exitInfo: { code: number | null; signal: string | null } | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    // 止めたあと、グループが空になったかを調べるタイマー
    let pollTimer: NodeJS.Timeout | undefined;
    // SIGKILL を送った時刻
    let killedAt: number | undefined;

    // すでに終わったグループへ送ると ESRCH で落ちるので、握り潰す
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // すでに終わっている
      }
    };

    // グループにまだ誰かいるか。先頭が終わったあとも、グループ ID は残りのプロセスが使い続ける
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        // ESRCH はグループに誰もいない。EPERM はいるが、信号を送る権限が無い
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(pollTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null, exitSignal: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopReason === "overflow") {
        reject(
          new Error(
            `slack-cli の出力が上限（${maxBuffer} バイト）を超えました`,
          ),
        );
        return;
      }
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut: stopReason === "timeout",
        aborted: stopReason === "abort",
      });
    };

    // 止めたあと、先頭が終わったときに呼ぶ。グループが空になっていれば結果を返す。
    // 子が残っていれば、空になるまで待つ（猶予を過ぎれば、killTimer が SIGKILL を送る）。
    // SIGKILL を送っても残るプロセス（終了待ちで固まったものなど）は、待ちきれないので、そのまま返す
    const finishWhenGroupEnds = () => {
      if (settled || exitInfo === undefined) return;
      const gaveUp =
        killedAt !== undefined && Date.now() - killedAt >= KILL_SETTLE_MS;
      if (gaveUp || !groupAlive()) {
        finish(exitInfo.code, exitInfo.signal);
        return;
      }
      pollTimer = setTimeout(finishWhenGroupEnds, GROUP_POLL_MS);
    };

    const stop = (reason: StopReason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (exitInfo) {
        // 先頭は終わっているが、残った子が管を握っていて close が来ない。グループごと止めて、いまの結果で終える
        killGroup("SIGKILL");
        finish(exitInfo.code, exitInfo.signal);
        return;
      }
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        killedAt = Date.now();
      }, KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        stop("overflow");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    // 起動できなかったとき（コマンドが無い・実行できないなど）
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("exit", (code, exitSignal) => {
      exitInfo = { code, signal: exitSignal };
      // 止めたときは、残りの出力を待たない。グループごと止めたので、読み残しは要らない。
      // ただし、グループに子が残っている間は終えない（先頭だけが先に終わることがある）
      if (stopReason) finishWhenGroupEnds();
    });
    // 通常の終わり方。出力を読み切ってから終える。
    // 止めたときは、管が閉じても子が動き続けることがあるので、上の finishWhenGroupEnds に任せる
    child.on("close", (code, exitSignal) => {
      if (!stopReason) finish(code, exitSignal);
    });
  });
}

// slack-cli を呼ぶ関数。呼び出しごとに timeout と signal を受ける。
// 見つからないときは、呼ぶ前に missingError で reject する（起動できなかったときと同じ形）
export type Run = (
  args: readonly string[],
  options: RunOptions,
) => Promise<CliResult>;

// 設定の値で slack-cli を呼ぶ関数を作る。呼ぶたびに、ファイルがあるかを調べ直す
export function createRun(
  settings: CliSettings,
  env: () => LaunchEnv = realEnv,
): Run {
  return (args, options) => {
    const built = buildInvocation(args, settings, env());
    return built.kind === "ok"
      ? runProcess(built.invocation, options)
      : Promise.reject(missingError(built.missing));
  };
}

// 0 以外で終わった・止めた slack-cli の結果を、画面に出すエラーの文にする
export function failureMessage(result: CliResult, timeoutMs: number): string {
  if (result.timedOut) {
    return `slack-cli が ${timeoutMs / 1000} 秒以内に終わらず止めました`;
  }
  if (result.aborted) return "slack-cli の呼び出しを中断しました";
  return cliErrorText(result);
}
