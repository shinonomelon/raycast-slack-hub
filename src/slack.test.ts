import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getLastReads,
  lastReadArgs,
  searchArgs,
  searchMessages,
  searchPage,
} from "./slack.ts";
import type { RunOptions } from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// このテストは Slack も slack-cli も呼ばない。slack-cli を呼ぶ部分（run）を、決まった結果を返す関数に差し替える

const NOW = 1_759_560_000_000;

// 自分のユーザー ID（テスト用のダミー）。自分宛てのメッセージかの判定に使う
const SELF = "U0000000017";

const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

// 呼ばれた引数と options を記録して、決まった結果を返す
function fakeRun(respond: () => CliResult | Error) {
  const calls: { args: readonly string[]; options: RunOptions }[] = [];
  const run = async (args: readonly string[], options: RunOptions) => {
    calls.push({ args, options });
    const response = respond();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, run };
}

// slack-cli の search --format raw の出力と同じ形（query・totalCount・page・pageCount・matches）。
// 各件は Slack の match そのまま（会話の ID と種類、permalink、スレッドの親が分かる）
const rawOutput = JSON.stringify(
  {
    query: "請求",
    totalCount: 842,
    page: 1,
    pageCount: 9,
    matches: [
      {
        ts: "1791043441.257549",
        text: "請求書を確認してください",
        user: "U0000000016",
        username: "example_sender",
        permalink:
          "https://example.slack.com/archives/C0000000007/p1791043441257549?thread_ts=1790967145.033309&cid=C0000000007",
        channel: {
          id: "C0000000007",
          name: "example_channel",
          is_private: false,
        },
      },
      {
        ts: "1791017660.885899",
        text: "DM です",
        user: "U0000000015",
        permalink:
          "https://example.slack.com/archives/D0000000010/p1791017660885899",
        channel: { id: "D0000000010", name: "U0000000015", is_im: true },
      },
    ],
  },
  null,
  2,
);

test("検索の引数は search -q <式> --sort timestamp -n 100 --format raw。式は1つの引数のまま渡す", () => {
  assert.deepEqual(searchArgs("請求 in:<#C1> -from:me"), [
    "search",
    "-q",
    "請求 in:<#C1> -from:me",
    "--sort",
    "timestamp",
    "-n",
    "100",
    "--format",
    "raw",
  ]);
});

test("検索結果の matches を Hit にする。会話の種類・スレッドの親・DM の相手の ID が分かる", async () => {
  const { calls, run } = fakeRun(() => cliResult({ stdout: rawOutput }));
  const signal = new AbortController().signal;
  const outcome = await searchMessages("請求", { selfId: SELF, run, signal });

  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  assert.equal(outcome.hits.length, 2);
  const [reply, dm] = outcome.hits;
  assert.equal(reply.key, "C0000000007:1791043441.257549");
  assert.equal(reply.threadTs, "1790967145.033309");
  assert.equal(reply.channelKind, "channel");
  assert.equal(reply.channelName, "example_channel");
  assert.equal(dm.channelKind, "im");
  // DM の channel.name は相手のユーザー ID
  assert.equal(dm.channelName, "U0000000015");
  assert.equal(dm.threadTs, undefined);

  // 15秒で打ち切り、呼び出し側の signal をそのまま渡す
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 15_000);
  assert.equal(calls[0].options.signal, signal);
});

test("自分宛て（mentionsSelf）かは、渡された自分のユーザー ID で決まる（決め打ちの ID を使わない）", async () => {
  const stdout = JSON.stringify({
    totalCount: 1,
    matches: [
      {
        ts: "1791043441.257549",
        text: "<@U0000000017> 確認をお願いします",
        user: "U9",
        channel: { id: "C1", name: "general" },
      },
    ],
  });
  const { run } = fakeRun(() => cliResult({ stdout }));
  const asSelf = await searchMessages("確認", { run, selfId: SELF });
  assert.equal(asSelf.kind === "ok" && asSelf.hits[0].mentionsSelf, true);
  const asOther = await searchMessages("確認", {
    run,
    selfId: "U0000000014",
  });
  assert.equal(asOther.kind === "ok" && asOther.hits[0].mentionsSelf, false);
});

test("該当なし（matches が空）は、失敗でなく、空の結果", async () => {
  const { run } = fakeRun(() =>
    cliResult({
      stdout: JSON.stringify({
        query: "zzz",
        totalCount: 0,
        page: 1,
        pageCount: 0,
        matches: [],
      }),
    }),
  );
  assert.deepEqual(await searchMessages("zzz", { selfId: SELF, run }), {
    kind: "ok",
    hits: [],
  });
});

test("時間切れは失敗で、30秒止める期限が付く", async () => {
  const { run } = fakeRun(() =>
    cliResult({ code: null, signal: "SIGTERM", timedOut: true }),
  );
  const outcome = await searchMessages("請求", {
    selfId: SELF,
    run,
    now: () => NOW,
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "timeout");
  assert.deepEqual(outcome.failure.pause, {
    until: NOW + 30_000,
    cause: "timeout",
  });
});

test("回数制限（標準エラーの retry の秒数）は、その秒数だけ止める期限が付き、Slack が断ったほかの失敗には付かない", async () => {
  const limited = fakeRun(() =>
    cliResult({
      code: 1,
      stderr:
        "✗ Error: A rate-limit has been reached, you may retry this request in 45 seconds\n",
    }),
  );
  const outcome = await searchMessages("請求", {
    selfId: SELF,
    run: limited.run,
    now: () => NOW,
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.failure.kind, "rate_limited");
    assert.equal(outcome.failure.pause?.until, NOW + 45_000);
  }

  const other = fakeRun(() =>
    cliResult({
      code: 1,
      stderr: "✗ Error: An API error occurred: invalid_cursor\n",
    }),
  );
  const rejected = await searchMessages("請求", {
    selfId: SELF,
    run: other.run,
  });
  assert.equal(rejected.kind, "failed");
  if (rejected.kind === "failed") {
    assert.equal(rejected.failure.kind, "error");
    assert.equal(rejected.failure.pause, undefined);
  }
});

test("新しい入力で中断したものは、失敗でなく中断として返す（run が投げたときも、中断されていれば中断）", async () => {
  const aborted = fakeRun(() =>
    cliResult({ code: null, signal: "SIGTERM", aborted: true }),
  );
  assert.deepEqual(
    await searchMessages("請求", { selfId: SELF, run: aborted.run }),
    {
      kind: "aborted",
    },
  );

  // run が投げても、中断されていれば中断
  const controller = new AbortController();
  const throwing = fakeRun(() => {
    controller.abort();
    return new Error("途中で止まった");
  });
  assert.deepEqual(
    await searchMessages("請求", {
      selfId: SELF,
      run: throwing.run,
      signal: controller.signal,
    }),
    { kind: "aborted" },
  );
});

test("slack-cli を起動できない・出力が上限を超えたときは、投げずに、止めない失敗として返す", async () => {
  const { run } = fakeRun(
    () => new Error("slack-cli の出力が上限（268435456 バイト）を超えました"),
  );
  const outcome = await searchMessages("請求", { selfId: SELF, run });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "error");
  assert.equal(outcome.failure.pause, undefined);
  assert.ok(outcome.failure.message.includes("上限"));
});

test("出力が読めないときは、止めない失敗として返す（JSON でない・matches が無い）", async () => {
  for (const stdout of ["", "No messages found", "{ 壊れた", '{"query":"x"}']) {
    const { run } = fakeRun(() => cliResult({ stdout }));
    const outcome = await searchMessages("請求", { selfId: SELF, run });
    assert.equal(outcome.kind, "failed", stdout);
    if (outcome.kind === "failed") {
      assert.equal(outcome.failure.kind, "error", stdout);
      assert.equal(outcome.failure.pause, undefined, stdout);
    }
  }
});

test("会話の ID も ts も分からない match は捨て、読めるものだけを返す", async () => {
  const { run } = fakeRun(() =>
    cliResult({
      stdout: JSON.stringify({
        matches: [
          { text: "ID も ts も無い" },
          { ts: "1.000001", text: "読める", channel: { id: "C1" } },
        ],
      }),
    }),
  );
  const outcome = await searchMessages("請求", { selfId: SELF, run });
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.deepEqual(
      outcome.hits.map((h) => h.key),
      ["C1:1.000001"],
    );
  }
});

// ---- 既読位置の取得（channel last-read） -----------------------------------------------

// slack-cli の channel last-read --format json の出力と同じ形（会話ごとに channelId・lastRead・reason、入力の順）。
// 取れた行も reason は null。retryAfter は rate_limited の行だけに付く
const lastReadOutput = JSON.stringify(
  [
    { channelId: "C1", lastRead: "1790967145.033309", reason: null },
    { channelId: "C2", lastRead: null, reason: "no_last_read" },
    { channelId: "C3", lastRead: null, reason: "not_visible" },
    { channelId: "C4", lastRead: null, reason: "rate_limited", retryAfter: 45 },
    { channelId: "C5", lastRead: null, reason: "error" },
  ],
  null,
  2,
);

test("既読位置の引数は channel last-read <会話 ID…> --format json。会話 ID は1つずつの引数のまま渡す", () => {
  assert.deepEqual(lastReadArgs(["C1", "D2", "G3"]), [
    "channel",
    "last-read",
    "C1",
    "D2",
    "G3",
    "--format",
    "json",
  ]);
});

test("既読位置を、会話ごとに理由つきで読む。標準エラーの理由の行は、終了コード 0 なら失敗として見ない。30秒で打ち切る", async () => {
  const { calls, run } = fakeRun(() =>
    cliResult({
      stdout: lastReadOutput,
      stderr:
        "⚠ Could not read last_read for C2: no_last_read\n⚠ Could not read last_read for C3: not_visible\n",
    }),
  );
  const outcome = await getLastReads(["C1", "C2", "C3", "C4", "C5"], { run });
  assert.deepEqual(outcome, {
    kind: "ok",
    rows: [
      { channelId: "C1", lastRead: "1790967145.033309", reason: null },
      { channelId: "C2", lastRead: null, reason: "no_last_read" },
      { channelId: "C3", lastRead: null, reason: "not_visible" },
      {
        channelId: "C4",
        lastRead: null,
        reason: "rate_limited",
        retryAfter: 45,
      },
      { channelId: "C5", lastRead: null, reason: "error" },
    ],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, lastReadArgs(["C1", "C2", "C3", "C4", "C5"]));
  assert.equal(calls[0].options.timeoutMs, 30_000);
  // 呼び出しは中断しない（取り直しの途中でも最後まで行い、結果を保存する）
  assert.equal(calls[0].options.signal, undefined);
});

test("1回に取るのは20会話まで。重複と、会話 ID の形でないもの（オプションと取り違えるもの）は渡さない", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `C${i}`);
  const { calls, run } = fakeRun(() => cliResult({ stdout: "[]" }));
  await getLastReads(
    ["-h", "--format", "c1", "", "C 1", "C0", "C0", ...ids.slice(1)],
    { run },
  );
  assert.equal(calls.length, 1);
  // channel last-read のあと、--format json の前までが会話 ID
  const requested = calls[0].args.slice(2, -2);
  assert.equal(requested.length, 20);
  assert.deepEqual(requested, ids.slice(0, 20));
  assert.deepEqual(calls[0].args.slice(-2), ["--format", "json"]);
});

test("取る会話が無いときは、slack-cli を起動しない", async () => {
  const { calls, run } = fakeRun(() => cliResult({ stdout: "[]" }));
  assert.deepEqual(await getLastReads([], { run }), { kind: "ok", rows: [] });
  assert.deepEqual(await getLastReads(["", "-x", "c1"], { run }), {
    kind: "ok",
    rows: [],
  });
  assert.equal(calls.length, 0);
});

test("時間切れは失敗で、30秒止める期限が付く（既読位置の取得だけを止めるための期限）", async () => {
  const { run } = fakeRun(() =>
    cliResult({ code: null, signal: "SIGTERM", timedOut: true }),
  );
  const outcome = await getLastReads(["C1"], { run, now: () => NOW });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "timeout");
  assert.deepEqual(outcome.failure.pause, {
    until: NOW + 30_000,
    cause: "timeout",
  });
});

test("全体の失敗：認証の失敗（token_expired など）は止めずにエラー。標準エラーに待つ秒数があればその秒数止める", async () => {
  const auth = fakeRun(() =>
    cliResult({
      code: 1,
      stderr: "✗ Error: An API error occurred: token_expired\n",
    }),
  );
  const expired = await getLastReads(["C1"], { run: auth.run });
  assert.equal(expired.kind, "failed");
  if (expired.kind === "failed") {
    assert.equal(expired.failure.kind, "error");
    assert.equal(expired.failure.pause, undefined);
    assert.equal(
      expired.failure.message,
      "An API error occurred: token_expired",
    );
  }

  const limited = fakeRun(() =>
    cliResult({
      code: 1,
      stderr:
        "✗ Error: A rate-limit has been reached, you may retry this request in 45 seconds\n",
    }),
  );
  const outcome = await getLastReads(["C1"], {
    run: limited.run,
    now: () => NOW,
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.failure.kind, "rate_limited");
    assert.equal(outcome.failure.pause?.until, NOW + 45_000);
  }
});

test("slack-cli を起動できない・出力が上限を超えたときは、投げずに、止めない失敗として返す", async () => {
  const { run } = fakeRun(
    () => new Error("slack-cli の出力が上限（268435456 バイト）を超えました"),
  );
  const outcome = await getLastReads(["C1"], { run });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "error");
  assert.equal(outcome.failure.pause, undefined);
  assert.ok(outcome.failure.message.includes("上限"));
});

test("出力が読めないときは、止めない失敗として返す（JSON でない・配列でない）", async () => {
  for (const stdout of ["", "No channels", "{ 壊れた", '{"channelId":"C1"}']) {
    const { run } = fakeRun(() => cliResult({ stdout }));
    const outcome = await getLastReads(["C1"], { run });
    assert.equal(outcome.kind, "failed", stdout);
    if (outcome.kind === "failed") {
      assert.equal(outcome.failure.kind, "error", stdout);
      assert.equal(outcome.failure.pause, undefined, stdout);
    }
  }
});

test("形の合わない行は error にして保存させず、頼んでいない会話と重複の行は使わない", async () => {
  const { run } = fakeRun(() =>
    cliResult({
      stdout: JSON.stringify([
        // 知らない理由
        { channelId: "C1", lastRead: null, reason: "ふしぎ" },
        // 取れたことになっているが、ts の形でない
        { channelId: "C2", lastRead: "昨日", reason: null },
        // 取れたことになっているが、値が無い
        { channelId: "C3", lastRead: null, reason: null },
        // retryAfter が無い rate_limited は、そのまま読む（待つ秒数は付けない）
        { channelId: "C4", lastRead: null, reason: "rate_limited" },
        // rate_limited でない行の retryAfter は読まない
        { channelId: "C5", lastRead: null, reason: "error", retryAfter: 9 },
        // 理由があるのに値が入っていても、値は使わない
        { channelId: "C6", lastRead: "1790967145.033309", reason: "error" },
        // 頼んでいない会話・会話 ID が読めない行・重複は使わない
        { channelId: "C99", lastRead: "1790967145.033309", reason: null },
        { lastRead: "1790967145.033309", reason: null },
        "文字",
        null,
        { channelId: "C1", lastRead: "1790967145.033309", reason: null },
      ]),
    }),
  );
  const outcome = await getLastReads(["C1", "C2", "C3", "C4", "C5", "C6"], {
    run,
  });
  assert.deepEqual(outcome, {
    kind: "ok",
    rows: [
      { channelId: "C1", lastRead: null, reason: "error" },
      { channelId: "C2", lastRead: null, reason: "error" },
      { channelId: "C3", lastRead: null, reason: "error" },
      { channelId: "C4", lastRead: null, reason: "rate_limited" },
      { channelId: "C5", lastRead: null, reason: "error" },
      { channelId: "C6", lastRead: null, reason: "error" },
    ],
  });
});

// ---- 検索結果1ページ（件数の上限で切れたか・古い順） -----------------------------------------

test("古い順を指定したときだけ --sort-dir asc を足す。省略か desc なら、今までと同じ引数", () => {
  const base = searchArgs("in:<#C1>");
  assert.deepEqual(searchArgs("in:<#C1>", "desc"), base);
  assert.deepEqual(searchArgs("in:<#C1>", "asc"), [
    ...base,
    "--sort-dir",
    "asc",
  ]);
});

test("Slack の総件数が、取れた件数より多ければ、件数の上限で切れたことになる", async () => {
  const output = (totalCount: unknown, matches = 2) =>
    JSON.stringify({
      query: "x",
      totalCount,
      page: 1,
      pageCount: 9,
      matches: Array.from({ length: matches }, (_, i) => ({
        ts: `1790000000.00000${i}`,
        text: "本文",
        channel: { id: "C1" },
      })),
    });
  const capped = async (stdout: string) => {
    const { run } = fakeRun(() => cliResult({ stdout }));
    const outcome = await searchPage("in:<#C1>", { selfId: SELF, run });
    assert.equal(outcome.kind, "ok", stdout);
    return outcome.kind === "ok" ? outcome.capped : undefined;
  };
  // 総件数 842 で、取れたのは 2 件
  assert.equal(await capped(output(842)), true);
  // 総件数と取れた件数が同じなら、切れていない
  assert.equal(await capped(output(2)), false);
  // 総件数が分からない・読めない値のときは、切れていないものとして扱う
  assert.equal(await capped(output(undefined)), false);
  assert.equal(await capped(output("たくさん")), false);
  assert.equal(await capped(output(0, 0)), false);
});

test("読めなかった match があっても、切れたかは slack-cli が返した match の数で決める", async () => {
  const { run } = fakeRun(() =>
    cliResult({
      stdout: JSON.stringify({
        totalCount: 2,
        matches: [
          { text: "ID も ts も無い" },
          { ts: "1.000001", text: "読める", channel: { id: "C1" } },
        ],
      }),
    }),
  );
  const outcome = await searchPage("in:<#C1>", { selfId: SELF, run });
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    // 読めたのは1件だが、総件数 2 と match の数 2 は同じ → 切れていない
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.capped, false);
  }
});

test("古い順の指定は slack-cli の引数に届く。失敗の分類は searchMessages と同じ", async () => {
  const ok = fakeRun(() =>
    cliResult({ stdout: JSON.stringify({ totalCount: 0, matches: [] }) }),
  );
  await searchPage("in:<#C1> after:2026-09-30", {
    selfId: SELF,
    run: ok.run,
    sortDir: "asc",
  });
  assert.deepEqual(ok.calls[0].args.slice(-2), ["--sort-dir", "asc"]);

  const limited = fakeRun(() =>
    cliResult({
      code: 1,
      stderr:
        "✗ Error: A rate-limit has been reached, you may retry this request in 45 seconds\n",
    }),
  );
  const outcome = await searchPage("請求", {
    selfId: SELF,
    run: limited.run,
    now: () => NOW,
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.failure.kind, "rate_limited");
    assert.equal(outcome.failure.pause?.until, NOW + 45_000);
  }
});
