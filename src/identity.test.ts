import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheNamespace,
  decideFetch,
  fetchIdentity,
  FAILURE_TITLES,
  identityCacheKey,
  identityView,
  judgeWhoami,
  maskTokens,
  missingFailure,
  parseWhoami,
  readIdentity,
  scopeKey,
  selfHandles,
  sessionOf,
  WHOAMI_TIMEOUT_MS,
  type FetchDeps,
  type Identity,
  type IdentityFailureKind,
  type IdentityOutcome,
} from "./identity.ts";
import type { CliSettings, Invocation, RunOptions } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// このテストは Slack も slack-cli も呼ばない。whoami の出力・ファイルの有無・プロセスの実行は、偽物に差し替える

// テスト用のダミーの値
const ME: Identity = {
  userId: "U0000000017",
  user: "taro_y",
  teamId: "T0000000012",
  team: "Example Inc",
  url: "https://example.slack.com/",
};

const whoamiJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...ME, ...overrides }, null, 2);

const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

// ---- whoami の読み取り -------------------------------------------------------------------

test("whoami の JSON から、ID・ワークスペースの ID・ハンドルを読む。slack-cli が実際に出す形（2文字字下げと末尾の改行）も読める", () => {
  assert.deepEqual(parseWhoami(`${whoamiJson()}\n`), ME);
  assert.deepEqual(readIdentity(JSON.parse(whoamiJson())), ME);
});

test("読むのは5項目だけ。ほかの項目（もしトークンが混ざっていても）は持たない", () => {
  const identity = parseWhoami(whoamiJson({ token: "dummy-secret" }));
  assert.deepEqual(identity, ME);
  assert.deepEqual(Object.keys(identity ?? {}).sort(), [
    "team",
    "teamId",
    "url",
    "user",
    "userId",
  ]);
});

test("項目が欠けている・形が違うときは、読めないものとして扱う", () => {
  for (const missing of ["userId", "user", "teamId", "team", "url"]) {
    const fields: Record<string, unknown> = { ...ME };
    delete fields[missing];
    assert.equal(readIdentity(fields), undefined, `${missing} が欠けている`);
  }
  const bad: [string, unknown][] = [
    ["userId", 12345],
    ["userId", ""],
    ["userId", null],
    ["teamId", ["T1"]],
    ["teamId", ""],
    ["user", ""],
    ["user", "   "],
    ["team", 7],
    ["url", ""],
  ];
  for (const [field, value] of bad) {
    assert.equal(
      readIdentity({ ...ME, [field]: value }),
      undefined,
      `${field}=${JSON.stringify(value)}`,
    );
  }
  for (const value of [null, undefined, 42, "text", true, [], [ME]]) {
    assert.equal(readIdentity(value), undefined, JSON.stringify(value));
  }
});

test("ID は Cache の名前空間（フォルダの名前）に入るので、記号・空白・パスの区切りを含むものは読めないものとして扱う", () => {
  for (const id of [
    "../U1",
    "U1/../../x",
    "U1/2",
    "U1:2",
    "U 1",
    "U1-2",
    "..",
    "U1\n",
    "ユーザー",
  ]) {
    assert.equal(readIdentity({ ...ME, userId: id }), undefined, id);
    assert.equal(readIdentity({ ...ME, teamId: id }), undefined, id);
  }
  // 英数字だけなら読める（Slack の ID の形）
  assert.ok(readIdentity({ ...ME, userId: "W0A1B2C3D4", teamId: "E0A1B2" }));
});

test("出力が JSON でないとき・空のときも、読めないものとして扱い、投げない", () => {
  for (const stdout of ["", "not json", "{", "{ broken: true }", "[1, 2]"]) {
    assert.equal(parseWhoami(stdout), undefined, JSON.stringify(stdout));
  }
});

// ---- Cache の名前空間 --------------------------------------------------------------------

test("Cache の名前空間に teamId と userId が入り、種類ごとに別になる。コロンもパスの区切りも使わない", () => {
  assert.equal(scopeKey(ME), "T0000000012-U0000000017");
  assert.equal(
    cacheNamespace("directory", ME),
    "directory-T0000000012-U0000000017",
  );
  assert.equal(
    cacheNamespace("messages", ME),
    "messages-T0000000012-U0000000017",
  );
  // 種類（directory と messages）は、同じ名前空間に入れない（索引を上書きし合って一覧を失うため）
  assert.notEqual(
    cacheNamespace("directory", ME),
    cacheNamespace("messages", ME),
  );
  for (const kind of ["directory", "messages"] as const) {
    assert.ok(!/[:/\\\s]/.test(cacheNamespace(kind, ME)), kind);
  }
});

test("人（ワークスペースか自分の ID）が違えば、名前空間も違う。自分の情報が決まる前の名前空間（directory・messages）は使わない", () => {
  const otherUser = { ...ME, userId: "U0000000014" };
  const otherTeam = { ...ME, teamId: "T0000000011" };
  for (const kind of ["directory", "messages"] as const) {
    const base = cacheNamespace(kind, ME);
    assert.notEqual(cacheNamespace(kind, otherUser), base);
    assert.notEqual(cacheNamespace(kind, otherTeam), base);
    assert.notEqual(
      cacheNamespace(kind, otherUser),
      cacheNamespace(kind, otherTeam),
    );
    // 古い名前空間の中身は、読まない・書かない（消さない）。新しい名前空間は、その名前にならない
    assert.notEqual(base, kind);
  }
});

test("前回の結果を持つキーは、slack-cli の場所とプロファイルの組ごとに別。パスの記号を含まない（ハッシュ）", () => {
  const settings = {
    slackCliPath: "~/slack-cli/dist/index.js",
    slackCliProfile: "work",
  };
  const key = identityCacheKey(settings);
  assert.match(key, /^[0-9a-f]{32}$/);
  // 同じ組なら同じキー（前後の空白は無視する）
  assert.equal(
    identityCacheKey({
      slackCliPath: ` ${settings.slackCliPath}\n`,
      slackCliProfile: " work ",
    }),
    key,
  );
  // どちらかが違えば別のキー
  assert.notEqual(
    identityCacheKey({ ...settings, slackCliProfile: "other" }),
    key,
  );
  assert.notEqual(
    identityCacheKey({
      ...settings,
      slackCliPath: "/opt/homebrew/bin/slack-cli",
    }),
    key,
  );
  assert.notEqual(
    identityCacheKey({ slackCliPath: "", slackCliProfile: "" }),
    key,
  );
  // 区切りの違いで、別の組が同じキーにならない
  assert.notEqual(
    identityCacheKey({ slackCliPath: "a", slackCliProfile: "bc" }),
    identityCacheKey({ slackCliPath: "ab", slackCliProfile: "c" }),
  );
});

// ---- 自分のハンドル ---------------------------------------------------------------------

test("自分のハンドルの一覧は、whoami の user と Previous Handles。前後の空白と先頭の @ を除き、重複を除く", () => {
  assert.deepEqual(selfHandles("taro_y", ""), ["taro_y"]);
  assert.deepEqual(selfHandles("taro_y", "old_taro"), ["taro_y", "old_taro"]);
  assert.deepEqual(selfHandles("taro_y", " old_taro , @older_taro ,, @ "), [
    "taro_y",
    "old_taro",
    "older_taro",
  ]);
  // 重複（user と同じ、前のハンドルどうし）は1つにする。順は、user・前のハンドルの順
  assert.deepEqual(selfHandles("taro_y", "old_taro,@taro_y,old_taro"), [
    "taro_y",
    "old_taro",
  ]);
  assert.deepEqual(selfHandles("@taro_y ", "@@old_taro"), [
    "taro_y",
    "old_taro",
  ]);
});

test("Previous Handles は、全角のカンマ（，・、）でも区切る", () => {
  assert.deepEqual(selfHandles("taro_y", "old_a，old_b、old_c"), [
    "taro_y",
    "old_a",
    "old_b",
    "old_c",
  ]);
});

// ---- 取れないときの理由と文 ------------------------------------------------------------------

test("取れないときの見出しは4つ（README の「困ったとき」が、この文で案内する）", () => {
  assert.deepEqual(FAILURE_TITLES, {
    "cli-not-found": "slack-cli が見つかりません",
    "node-not-found": "node が見つかりません",
    "no-whoami": "この slack-cli には whoami がありません",
    failed: "Slack に自分の情報を問い合わせられませんでした",
  });
});

test("slack-cli が見つからないとき：指定したパスに無いなら、そのパスを出して、設定の直し方を伝える", () => {
  const failure = missingFailure({
    target: "slack-cli",
    configured: "/Users/example/slack-cli/dist/index.js",
    searched: ["/Users/example/slack-cli/dist/index.js"],
  });
  assert.equal(failure.kind, "cli-not-found");
  assert.equal(failure.title, "slack-cli が見つかりません");
  assert.ok(failure.message.includes("/Users/example/slack-cli/dist/index.js"));
  assert.ok(failure.message.includes("slack-cli Path"));
});

test("slack-cli が見つからないとき：決まった場所のどこにも無いなら、探したフォルダを順に並べて、設定の直し方を伝える", () => {
  const failure = missingFailure({
    target: "slack-cli",
    configured: undefined,
    searched: [
      "/Users/example/.volta/bin/slack-cli",
      "/opt/homebrew/bin/slack-cli",
      "/usr/local/bin/slack-cli",
    ],
  });
  assert.equal(failure.kind, "cli-not-found");
  assert.ok(
    failure.message.includes(
      "/Users/example/.volta/bin・/opt/homebrew/bin・/usr/local/bin",
    ),
  );
  assert.ok(failure.message.includes("slack-cli Path"));
  assert.ok(failure.message.includes("dist/index.js"));
});

test("node が見つからないとき：指定したパスに無いとき・決まった場所のどこにも無いとき、それぞれ Node Path の直し方を伝える", () => {
  const specified = missingFailure({
    target: "node",
    configured: "/Users/example/nope/node",
    searched: ["/Users/example/nope/node"],
  });
  assert.equal(specified.kind, "node-not-found");
  assert.equal(specified.title, "node が見つかりません");
  assert.ok(specified.message.includes("/Users/example/nope/node"));
  assert.ok(specified.message.includes("Node Path"));
  // node のパスは、一時的なリンクや shim ではなく、実体のパスを返す方法で調べてもらう
  assert.ok(specified.message.includes("node -p process.execPath"));
  assert.ok(!specified.message.includes("which node"));

  const searched = missingFailure({
    target: "node",
    configured: undefined,
    searched: ["/Users/example/.volta/bin/node", "/opt/homebrew/bin/node"],
  });
  assert.equal(searched.kind, "node-not-found");
  assert.ok(
    searched.message.includes("/Users/example/.volta/bin・/opt/homebrew/bin"),
  );
  assert.ok(searched.message.includes("Node Path"));
  assert.ok(searched.message.includes(".js"));
  assert.ok(searched.message.includes("node -p process.execPath"));
  assert.ok(!searched.message.includes("which node"));
});

test("本家の slack-cli（whoami を知らない）は、標準エラーの unknown command で見分ける。本家で実際に出る文（終了コード1）", () => {
  const outcome = judgeWhoami(
    cliResult({ code: 1, stderr: "error: unknown command 'whoami'\n" }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no-whoami");
  assert.equal(
    outcome.failure.title,
    "この slack-cli には whoami がありません",
  );
  assert.ok(outcome.failure.message.includes("slack-cli Path"));
  assert.ok(outcome.failure.message.includes("改造版"));

  // 色の制御文字が混ざっていても見分ける
  const colored = judgeWhoami(
    cliResult({
      code: 1,
      stderr: `${String.fromCharCode(27)}[31merror: unknown command 'whoami'${String.fromCharCode(27)}[39m\n`,
    }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(colored.kind === "failed" && colored.failure.kind, "no-whoami");
});

test("whoami が取れたら、自分の情報になる", () => {
  assert.deepEqual(
    judgeWhoami(cliResult({ stdout: whoamiJson() }), WHOAMI_TIMEOUT_MS),
    { kind: "ok", identity: ME },
  );
});

test("終了コード0でも出力が読めなければ、取れなかったものとして扱う（誤った人の情報にしない）", () => {
  for (const stdout of ["", "ok", whoamiJson({ userId: "../x" })]) {
    const outcome = judgeWhoami(cliResult({ stdout }), WHOAMI_TIMEOUT_MS);
    assert.equal(outcome.kind, "failed", JSON.stringify(stdout));
    if (outcome.kind === "failed") {
      assert.equal(outcome.failure.kind, "failed");
      assert.equal(outcome.failure.title, FAILURE_TITLES.failed);
      assert.ok(outcome.failure.message.includes("読み取れません"));
    }
  }
});

test("それ以外の失敗は「Slack に自分の情報を問い合わせられませんでした」。slack-cli のエラーの文を添え、設定の見直しを伝える", () => {
  const outcome = judgeWhoami(
    cliResult({
      code: 1,
      stderr: "✗ Error: An API error occurred: invalid_auth\n",
    }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "failed");
  assert.equal(outcome.failure.title, FAILURE_TITLES.failed);
  assert.ok(
    outcome.failure.message.includes("An API error occurred: invalid_auth"),
  );
  assert.ok(outcome.failure.message.includes("slack-cli Profile"));
  assert.ok(!outcome.failure.message.includes("unknown command"));
});

test("エラーの文の文末の句点は取って、直し方の文につなぐ", () => {
  const outcome = judgeWhoami(
    cliResult({ code: 1, stderr: "✗ Error: Something went wrong.\n" }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.ok(
      outcome.failure.message.startsWith("Something went wrong。拡張の設定"),
      outcome.failure.message,
    );
  }
});

test("時間切れ・中断・シグナルで止まったときも、取れなかったもの（本家の判定にしない）", () => {
  const timedOut = judgeWhoami(
    cliResult({ code: null, signal: "SIGTERM", timedOut: true }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(timedOut.kind === "failed" && timedOut.failure.kind, "failed");
  assert.ok(
    timedOut.kind === "failed" &&
      timedOut.failure.message.includes("30 秒以内に終わらず止めました"),
  );

  const aborted = judgeWhoami(
    cliResult({ code: null, signal: "SIGTERM", aborted: true }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(aborted.kind === "failed" && aborted.failure.kind, "failed");

  // 止めたあとに残っていた出力に unknown command があっても、時間切れを本家とは見なさない
  const stale = judgeWhoami(
    cliResult({
      code: null,
      timedOut: true,
      stderr: "error: unknown command 'whoami'\n",
    }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(stale.kind === "failed" && stale.failure.kind, "failed");

  const killed = judgeWhoami(
    cliResult({ code: null, signal: "SIGKILL" }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(killed.kind, "failed");
});

test("エラーの文に混ざったトークンは出さない（xoxp-・xoxb-・xapp-・xoxe.xoxp- の形）。長い文は切る", () => {
  assert.equal(
    maskTokens("token xoxp-1234-abcd-efgh failed"),
    "token xox-*** failed",
  );
  assert.equal(
    maskTokens("a xoxb-1-2-c b xapp-1-A0-9-z"),
    "a xox-*** b xox-***",
  );
  assert.equal(maskTokens("rotating xoxe.xoxp-1-AbC-d"), "rotating xox-***");
  assert.equal(
    maskTokens("Invalid token: XOXP-9-8-7"),
    "Invalid token: xox-***",
  );
  assert.equal(
    maskTokens("トークンは入っていない文"),
    "トークンは入っていない文",
  );

  const outcome = judgeWhoami(
    cliResult({
      code: 1,
      stderr: "✗ Error: bad token xoxp-1234567890-abcdefghij sent\n",
    }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.ok(!outcome.failure.message.includes("xoxp-"));
    assert.ok(!outcome.failure.message.includes("1234567890-abcdefghij"));
    assert.ok(outcome.failure.message.includes("bad token xox-*** sent"));
  }

  const long = judgeWhoami(
    cliResult({ code: 1, stderr: `✗ Error: ${"あ".repeat(1000)}\n` }),
    WHOAMI_TIMEOUT_MS,
  );
  assert.ok(long.kind === "failed" && long.failure.message.length < 400);
});

// ---- whoami を呼ぶ ---------------------------------------------------------------------

const SETTINGS: CliSettings = {
  slackCliPath: "/opt/homebrew/bin/slack-cli",
  nodePath: "",
  slackCliProfile: "work",
};

// 偽の実行環境。files にあるパスだけが「ある」ことにし、呼ばれた呼び方を calls に残す
function fakeDeps(
  respond: (invocation: Invocation) => CliResult | Error,
  files: readonly string[] = ["/opt/homebrew/bin/slack-cli"],
) {
  const calls: { invocation: Invocation; options: RunOptions }[] = [];
  const deps: FetchDeps = {
    env: () => ({
      home: "/Users/example",
      baseEnv: { PATH: "/usr/local/bin" },
      exists: (path) => files.includes(path),
    }),
    run: async (invocation, options) => {
      calls.push({ invocation, options });
      const response = respond(invocation);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { deps, calls };
}

test("whoami は、設定の slack-cli を whoami --format json で呼ぶ。Profile は末尾に付く。時間切れは30秒", async () => {
  const { deps, calls } = fakeDeps(() => cliResult({ stdout: whoamiJson() }));
  const outcome = await fetchIdentity(SETTINGS, deps);
  assert.deepEqual(outcome, { kind: "ok", identity: ME });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].invocation.command, "/opt/homebrew/bin/slack-cli");
  assert.deepEqual(calls[0].invocation.args, [
    "whoami",
    "--format",
    "json",
    "--profile",
    "work",
  ]);
  assert.equal(calls[0].options.timeoutMs, 30_000);
});

test("slack-cli や node が見つからないときは、slack-cli を起動せず、その理由を返す", async () => {
  const none = fakeDeps(() => cliResult({ stdout: whoamiJson() }), []);
  const noCli = await fetchIdentity(SETTINGS, none.deps);
  assert.equal(none.calls.length, 0);
  assert.equal(noCli.kind === "failed" && noCli.failure.kind, "cli-not-found");

  const noNode = fakeDeps(
    () => cliResult({ stdout: whoamiJson() }),
    ["/Users/example/slack-cli/dist/index.js"],
  );
  const outcome = await fetchIdentity(
    { ...SETTINGS, slackCliPath: "~/slack-cli/dist/index.js" },
    noNode.deps,
  );
  assert.equal(noNode.calls.length, 0);
  assert.equal(
    outcome.kind === "failed" && outcome.failure.kind,
    "node-not-found",
  );
});

test("whoami を呼んで本家と分かったとき・失敗したとき・起動できなかったときも、投げずに、理由を返す", async () => {
  const kinds: [CliResult | Error, IdentityFailureKind][] = [
    [
      cliResult({ code: 1, stderr: "error: unknown command 'whoami'\n" }),
      "no-whoami",
    ],
    [
      cliResult({
        code: 1,
        stderr: "✗ Error: An API error occurred: not_authed\n",
      }),
      "failed",
    ],
    [new Error("spawn /opt/homebrew/bin/slack-cli EACCES"), "failed"],
    [new Error("slack-cli の出力が上限（1000 バイト）を超えました"), "failed"],
  ];
  for (const [response, kind] of kinds) {
    const { deps } = fakeDeps(() => response);
    const outcome = await fetchIdentity(SETTINGS, deps);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") assert.equal(outcome.failure.kind, kind);
  }
});

// ---- 取得してよいかの判断（decideFetch）：どの時点で取得を始めてよいか、どの人の名前空間を使うか ----------------

const OTHER: Identity = { ...ME, userId: "U0000000014", user: "hanako_s" };
const ok = (identity: Identity): IdentityOutcome => ({ kind: "ok", identity });
const failed = (kind: IdentityFailureKind): IdentityOutcome => ({
  kind: "failed",
  failure: { kind, title: FAILURE_TITLES[kind], message: "直し方" },
});
const FAILURE_KINDS: IdentityFailureKind[] = [
  "cli-not-found",
  "node-not-found",
  "no-whoami",
  "failed",
];

test("前回の結果があるとき：whoami を確かめている間は、取得しない。表示は前回の人。取得・書き込みに使う人は無い", () => {
  assert.deepEqual(decideFetch(ME, undefined), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
  });
});

test("前回の結果があるとき：whoami が成功したら、取得してよい。表示も取得も今回の人。前回と同じ人なら、同じ名前空間のまま", () => {
  const decision = decideFetch(ME, ok(ME));
  assert.deepEqual(decision, {
    canFetch: true,
    display: ME,
    fetchAs: ME,
  });
  assert.equal(
    cacheNamespace("directory", decision.fetchAs ?? OTHER),
    cacheNamespace("directory", ME),
  );
});

test("前回の結果があるとき：今回の結果が違う人なら、表示も取得も、その人の名前空間に切り替わる（前回の人の名前空間で取得しない）", () => {
  const decision = decideFetch(ME, ok(OTHER));
  assert.equal(decision.canFetch, true);
  assert.deepEqual(decision.display, OTHER);
  assert.deepEqual(decision.fetchAs, OTHER);
  for (const kind of ["directory", "messages"] as const) {
    assert.notEqual(
      cacheNamespace(kind, decision.fetchAs ?? ME),
      cacheNamespace(kind, ME),
      `${kind} が前回の人の名前空間のまま`,
    );
  }
});

test("前回の結果があるとき：whoami が取れなかったら（どの理由でも）、取得しない。表示は前回の人のまま。取得・書き込みに使う人は無い", () => {
  for (const kind of FAILURE_KINDS) {
    assert.deepEqual(
      decideFetch(ME, failed(kind)),
      { canFetch: false, display: ME, fetchAs: undefined },
      kind,
    );
  }
});

test("前回の結果が無いとき：確かめている間は、表示する人も取得する人も無い。成功してから、その人で取得を始める", () => {
  assert.deepEqual(decideFetch(undefined, undefined), {
    canFetch: false,
    display: undefined,
    fetchAs: undefined,
  });
  assert.deepEqual(decideFetch(undefined, ok(ME)), {
    canFetch: true,
    display: ME,
    fetchAs: ME,
  });
});

test("前回の結果が無いとき：whoami が取れなかったら、表示する人は無いまま。取得はしない", () => {
  for (const kind of FAILURE_KINDS) {
    assert.deepEqual(
      decideFetch(undefined, failed(kind)),
      { canFetch: false, display: undefined, fetchAs: undefined },
      kind,
    );
  }
});

test("取得してよい（canFetch）のは、今回の whoami が成功したときだけ。取得と書き込みに使う人は、今回の結果の人で、前回の結果の人ではない", () => {
  const outcomes: (IdentityOutcome | undefined)[] = [
    undefined,
    ...FAILURE_KINDS.map(failed),
    ok(ME),
    ok(OTHER),
  ];
  for (const previous of [undefined, ME, OTHER]) {
    for (const outcome of outcomes) {
      const decision = decideFetch(previous, outcome);
      const label = `${previous?.userId ?? "前回なし"} / ${outcome?.kind ?? "確かめ中"}`;
      assert.equal(decision.canFetch, outcome?.kind === "ok", label);
      // 取得してよいことと、取得・書き込みに使う人が決まっていることは、必ず同じ
      assert.equal(decision.canFetch, decision.fetchAs !== undefined, label);
      assert.deepEqual(
        decision.fetchAs,
        outcome?.kind === "ok" ? outcome.identity : undefined,
        label,
      );
      // 表示する人：成功したら今回の人、それ以外は前回の人
      assert.deepEqual(
        decision.display,
        outcome?.kind === "ok" ? outcome.identity : previous,
        label,
      );
    }
  }
});

test("sessionOf：表示する人がいれば、画面とフックに渡す形にする。取得してよいかと、取得する人は、判断のまま変えない", () => {
  assert.deepEqual(sessionOf(decideFetch(ME, ok(OTHER))), {
    canFetch: true,
    display: OTHER,
    fetchAs: OTHER,
  });
  // 確かめ中・失敗：前回の人の一覧は出すが、取得する人は無い
  assert.deepEqual(sessionOf(decideFetch(ME, undefined)), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
  });
  assert.deepEqual(sessionOf(decideFetch(ME, failed("no-whoami"))), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
  });
});

test("sessionOf：出す一覧が無い（前回の結果が無く、今回も成功していない）ときは、何も渡さない。取得できる形にもならない", () => {
  assert.equal(sessionOf(decideFetch(undefined, undefined)), undefined);
  for (const kind of FAILURE_KINDS) {
    assert.equal(sessionOf(decideFetch(undefined, failed(kind))), undefined);
  }
  // 取得できる形（canFetch）になるのは、成功のときだけ
  for (const previous of [undefined, ME]) {
    for (const outcome of [undefined, ...FAILURE_KINDS.map(failed)]) {
      assert.notEqual(
        sessionOf(decideFetch(previous, outcome))?.canFetch,
        true,
      );
    }
  }
});

test("identityView：判断に、理由と確かめ中かを添える。確かめ中は理由が無く、失敗は確かめ中でなく理由がある", () => {
  assert.deepEqual(identityView(ME, undefined), {
    decision: decideFetch(ME, undefined),
    failure: undefined,
    checking: true,
  });
  assert.deepEqual(identityView(undefined, ok(ME)), {
    decision: decideFetch(undefined, ok(ME)),
    failure: undefined,
    checking: false,
  });
  for (const kind of FAILURE_KINDS) {
    const view = identityView(ME, failed(kind));
    assert.deepEqual(view.decision, decideFetch(ME, failed(kind)), kind);
    assert.equal(view.failure?.kind, kind);
    assert.equal(view.failure?.title, FAILURE_TITLES[kind]);
    assert.equal(view.checking, false);
  }
});
