// 自分の情報（slack-cli の whoami の結果）。読み取り、Cache の名前空間、自分のハンドルの一覧、取れないときの理由と文、
// 取得を始めてよいかの判断。@raycast/api を読み込まないので、node のテストから動かせる。
//
// リンクのワークスペースの ID、自分宛ての検索の ID、グループ DM の名前から除くハンドルは、決め打ちにせず、
// 開くたびに whoami で取った値を使う。whoami が返るまで、Slack のデータは取らない
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { parseJson, stripAnsi } from "./cli-output.ts";
// 型だけを読む。値として読むと、設定を読む @raycast/api がテストの読み込みに連鎖する
import type { Settings } from "./settings.ts";
import {
  buildInvocation,
  failureMessage,
  realEnv,
  runProcess,
  type CliMissing,
  type CliSettings,
  type Invocation,
  type LaunchEnv,
  type RunOptions,
} from "./slack-cli.ts";
import type { CliResult } from "./types.ts";

// ---- 自分の情報 ----------------------------------------------------------------------

// whoami --format json の出力（トークンは含まない）
export type Identity = {
  userId: string;
  // グループ DM の名前（mpdm-…）に入るハンドル
  user: string;
  teamId: string;
  team: string;
  url: string;
};

// Slack の ID（U…・T…）の形。ID は Cache の名前空間（フォルダの名前）に入るので、記号を含むものは通さない
const SLACK_ID = /^[A-Za-z0-9]+$/;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

// JSON を読んだ値から、自分の情報を取り出す。5項目がそろっていて形が合うときだけ読める。
// 欠けている・形が違う（ID に記号を含む・文字でない・空）ときは、読めないもの（undefined）として扱う
export function readIdentity(value: unknown): Identity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { userId, user, teamId, team, url } = value as Record<string, unknown>;
  if (typeof userId !== "string" || !SLACK_ID.test(userId)) return undefined;
  if (typeof teamId !== "string" || !SLACK_ID.test(teamId)) return undefined;
  if (!isText(user) || !isText(team) || !isText(url)) return undefined;
  return { userId, user, teamId, team, url };
}

// whoami の標準出力（JSON）から、自分の情報を読む。JSON でないときも、読めないもの
export function parseWhoami(stdout: string): Identity | undefined {
  try {
    return readIdentity(parseJson<unknown>(stdout, undefined));
  } catch {
    return undefined;
  }
}

// ---- Cache の名前空間 -------------------------------------------------------------------

// ワークスペースと自分の ID を合わせた印。Cache の名前空間はサブフォルダになるので、コロンは使わない
export const scopeKey = (identity: Pick<Identity, "teamId" | "userId">) =>
  `${identity.teamId}-${identity.userId}`;

// 保存するデータの種類。同じ名前空間に複数の種類を入れると、索引（journal）を互いに上書きして一覧を失う
export type CacheKind = "directory" | "messages";

// 会話と人の一覧（directory）・既読位置と印と自分宛て（messages）の Cache の名前空間。
// 種類ごとに、ワークスペースと自分の ID ごとに分ける。トークンやプロファイルを替えても、別の人のデータが混ざらない
export const cacheNamespace = (
  kind: CacheKind,
  identity: Pick<Identity, "teamId" | "userId">,
) => `${kind}-${scopeKey(identity)}`;

// 前回の whoami の結果を持つ Cache のキー。slack-cli の場所とプロファイルの組ごとに別にする。
// 設定の値（パス）をそのままキーにしないよう、ハッシュにする（パスの記号を含まない）
export function identityCacheKey(
  settings: Pick<Settings, "slackCliPath" | "slackCliProfile">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.slackCliPath.trim(),
        settings.slackCliProfile.trim(),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

// ---- 自分のハンドル ---------------------------------------------------------------------

// ハンドルの前後の空白と、先頭の @ を除く
const normalizeHandle = (raw: string) => raw.trim().replace(/^@+/, "").trim();

// 自分のハンドルの一覧。whoami の user と、Previous Handles（カンマ区切り）。重複は除く。
// 古いグループ DM の名前には、作ったときのハンドルが残るので、改名した人は前のハンドルも要る。
// 全角のカンマ（，・、）も区切りにする（日本語入力のまま打たれても、1つのハンドルにならないように）
export function selfHandles(user: string, previousHandles: string): string[] {
  const handles = [user, ...previousHandles.split(/[,，、]/)]
    .map(normalizeHandle)
    .filter((handle) => handle !== "");
  return [...new Set(handles)];
}

// ---- 取れないときの理由と文 ----------------------------------------------------------------

export type IdentityFailureKind =
  "cli-not-found" | "node-not-found" | "no-whoami" | "failed";

// 画面の見出し。README の「困ったとき」が、この文で案内する
export const FAILURE_TITLES: Record<IdentityFailureKind, string> = {
  "cli-not-found": "slack-cli が見つかりません",
  "node-not-found": "node が見つかりません",
  "no-whoami": "この slack-cli には whoami がありません",
  failed: "Slack に自分の情報を問い合わせられませんでした",
};

// 取れないときの理由。title が見出し、message が原因と直し方。どれにも、拡張の設定を開く操作を付ける（画面側）
export type IdentityFailure = {
  kind: IdentityFailureKind;
  title: string;
  message: string;
};

export type IdentityOutcome =
  | { kind: "ok"; identity: Identity }
  | { kind: "failed"; failure: IdentityFailure };

// エラー文に混ざったトークンは出さない（xoxp-…・xoxb-…・xapp-…・xoxe.xoxp-… の形）
const TOKEN_PATTERN = /xox[a-z]*[-.][\w.-]+|xapp-[\w-]+/gi;
// 一覧の行に出すので、長すぎる文は切る
const DETAIL_LIMIT = 300;

export function maskTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, "xox-***");
}

// 文末の句点は取る（このあとに、直し方の文を続けるため）
const detailOf = (text: string): string => {
  const masked = maskTokens(text)
    .trim()
    .replace(/[.。]+$/, "");
  return masked.length > DETAIL_LIMIT
    ? `${masked.slice(0, DETAIL_LIMIT)}…`
    : masked;
};

const failure = (
  kind: IdentityFailureKind,
  message: string,
): IdentityOutcome => ({
  kind: "failed",
  failure: { kind, title: FAILURE_TITLES[kind], message },
});

// 探した場所（ファイルのパス）を、フォルダの名前で並べる
const folders = (searched: readonly string[]) =>
  searched.map((path) => dirname(path)).join("・");

// 見つからなかったものを、設定の直し方の文にする。
// node のパスの調べ方は which node ではなく node -p process.execPath にする。which node は、fnm ではシェルごとの
// 一時的なリンクを、mise では shim（実行のたびに版を選び直すもの）を返しうる。process.execPath は実体のパスを返す
export function missingFailure(missing: CliMissing): IdentityFailure {
  if (missing.target === "slack-cli") {
    return {
      kind: "cli-not-found",
      title: FAILURE_TITLES["cli-not-found"],
      message:
        missing.configured !== undefined
          ? `「slack-cli Path」に指定したファイルがありません（${missing.configured}）。改造版 slack-cli の dist/index.js のパスに直してください`
          : `${folders(missing.searched)} のどこにもありません。拡張の設定の「slack-cli Path」に、改造版 slack-cli の dist/index.js のパスを入れてください`,
    };
  }
  return {
    kind: "node-not-found",
    title: FAILURE_TITLES["node-not-found"],
    message:
      missing.configured !== undefined
        ? `「Node Path」に指定したファイルがありません（${missing.configured}）。端末で node -p process.execPath を実行した結果を入れてください`
        : `slack-cli Path が .js なので node で動かしますが、${folders(missing.searched)} のどこにも node がありません。端末で node -p process.execPath を実行した結果を、拡張の設定の「Node Path」に入れてください`,
  };
}

// 本家の slack-cli は whoami を知らない。commander が、標準エラーに unknown command と出して終わる
const UNKNOWN_COMMAND = /unknown command/i;

// 終わった whoami の結果を、自分の情報か、取れなかった理由にする。
// 終了コード 0 で出力が読めれば成功（時間切れで止めたはずが正常に終わっていたときも、終了コードが証拠）
export function judgeWhoami(
  result: CliResult,
  timeoutMs: number,
): IdentityOutcome {
  if (result.code === 0) {
    const identity = parseWhoami(result.stdout);
    return identity
      ? { kind: "ok", identity }
      : failure("failed", "whoami の出力を読み取れませんでした");
  }
  if (
    !result.timedOut &&
    !result.aborted &&
    UNKNOWN_COMMAND.test(stripAnsi(result.stderr))
  ) {
    return failure(
      "no-whoami",
      "本家の slack-cli を指しています（whoami は改造版にだけあります）。拡張の設定の「slack-cli Path」に、改造版 slack-cli の dist/index.js のパスを入れてください",
    );
  }
  return failure(
    "failed",
    `${detailOf(failureMessage(result, timeoutMs))}。拡張の設定の「slack-cli Profile」と、そのトークンを確かめてください`,
  );
}

// 起動できなかった・出力が上限を超えたなど、結果を得られなかったとき
function judgeError(error: unknown): IdentityOutcome {
  const text = error instanceof Error ? error.message : String(error);
  return failure(
    "failed",
    `${detailOf(text)}。拡張の設定の「slack-cli Path」と「Node Path」を確かめてください`,
  );
}

// ---- whoami を呼ぶ ----------------------------------------------------------------------

// whoami は Slack の auth.test を1回呼ぶだけ。これを過ぎたら、取れなかったものとして扱う
export const WHOAMI_TIMEOUT_MS = 30_000;

export type FetchDeps = {
  env: () => LaunchEnv;
  run: (invocation: Invocation, options: RunOptions) => Promise<CliResult>;
};

const realDeps: FetchDeps = { env: realEnv, run: runProcess };

// slack-cli の whoami を呼んで、自分の情報を取る。投げない（取れなかった理由は結果で返す）。
// 呼び方を組めなければ（slack-cli・node が無い）、slack-cli を起動しない
export async function fetchIdentity(
  settings: CliSettings,
  deps: FetchDeps = realDeps,
): Promise<IdentityOutcome> {
  const built = buildInvocation(
    ["whoami", "--format", "json"],
    settings,
    deps.env(),
  );
  if (built.kind === "missing") {
    return { kind: "failed", failure: missingFailure(built.missing) };
  }
  try {
    const result = await deps.run(built.invocation, {
      timeoutMs: WHOAMI_TIMEOUT_MS,
    });
    return judgeWhoami(result, WHOAMI_TIMEOUT_MS);
  } catch (error) {
    return judgeError(error);
  }
}

// ---- 取得してよいかの判断 --------------------------------------------------------------------

// 開いたあとの、Slack から取得してよいかと、どの人の名前空間を使うかの判断。
// 今回の whoami の状態（確かめ中・成功・失敗）と、前回の結果から決める。
// - canFetch：Slack から取得してよいか。今回の whoami が成功したときだけ true
// - display：保存した一覧を出す人（その人の名前空間から読む）。成功したらその人。
//   確かめ中と失敗のときは、前回の結果の人（無ければ undefined）
// - fetchAs：Slack から取得して、結果を保存する人（その人の名前空間に書く）。成功した人だけ。
//   確かめ中と失敗のときは undefined（取得しない・書かない）
// 前回の結果の人で取得を始めると、トークンが別のワークスペースのものに替わっていたとき、前回の人の名前空間に
// 別の人の一覧を書いてしまう。前回の結果は表示にだけ使い、取得と書き込みは、今回成功した人にだけ許す。
// 一覧・検索・自分宛て・投稿フォームの人の取得（フック）は、この結果（Session）を通してだけ取得を始める
export type FetchDecision =
  | { canFetch: true; display: Identity; fetchAs: Identity }
  | { canFetch: false; display: Identity | undefined; fetchAs: undefined };

export function decideFetch(
  previous: Identity | undefined,
  outcome: IdentityOutcome | undefined,
): FetchDecision {
  if (outcome?.kind === "ok") {
    // 前回と違う人でも、今回の結果の人に切り替える（前回の人の名前空間で取得しない）
    return {
      canFetch: true,
      display: outcome.identity,
      fetchAs: outcome.identity,
    };
  }
  // 確かめ中（outcome が無い）と失敗：取得しない。前回の結果の人の保存した一覧は、出してよい
  return { canFetch: false, display: previous, fetchAs: undefined };
}

// 画面と、一覧・検索・自分宛てのフックに渡すもの。出す一覧があるとき（display があるとき）の FetchDecision
export type Session =
  | { canFetch: true; display: Identity; fetchAs: Identity }
  | { canFetch: false; display: Identity; fetchAs: undefined };

// 出す一覧が無い（前回の結果が無く、今回の whoami も成功していない）ときは undefined
export function sessionOf(decision: FetchDecision): Session | undefined {
  if (decision.canFetch) return decision;
  return decision.display
    ? { canFetch: false, display: decision.display, fetchAs: undefined }
    : undefined;
}

export type IdentityView = {
  // 取得してよいかと、どの人の名前空間を使うか
  decision: FetchDecision;
  // 今回の whoami が取れなかった理由
  failure: IdentityFailure | undefined;
  // 今回の whoami の結果を待っている
  checking: boolean;
};

// 前回の結果と、今回の whoami の結果（まだなら undefined）から、画面の状態を決める。
// - 待っている間：前回の結果があれば、その人の保存した一覧を出す。取得はしない
// - 成功：今回の結果。前回と違う人なら、その人の名前空間に切り替わる。ここから取得を始める
// - 失敗：前回の結果の一覧を出し続け、取得はしない。理由を出す
export function identityView(
  previous: Identity | undefined,
  outcome: IdentityOutcome | undefined,
): IdentityView {
  return {
    decision: decideFetch(previous, outcome),
    failure: outcome?.kind === "failed" ? outcome.failure : undefined,
    checking: outcome === undefined,
  };
}
