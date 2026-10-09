// auth.testで自分を確認してから取得し、キャッシュをワークスペース・ユーザーごとに分ける。
import { createHash } from "node:crypto";
import type { Settings } from "../shared/settings.ts";
import {
  createSlackApi,
  object,
  maskTokens,
  type ApiCall,
} from "./slack-api.ts";
export { maskTokens } from "./slack-api.ts";
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

// ワークスペースと自分の ID を合わせた印。Cache の名前空間はサブフォルダになるので、コロンは使わない
export const scopeKey = (identity: Pick<Identity, "teamId" | "userId">) =>
  `${identity.teamId}-${identity.userId}`;

// 保存するデータの種類。同じ名前空間に複数の種類を入れると、索引（journal）を互いに上書きして一覧を失う
export type CacheKind = "directory" | "messages";

// 会話と人の一覧（directory）・既読位置と印と自分宛て（messages）の Cache の名前空間。
// 種類ごとに、ワークスペースと自分の ID ごとに分ける。トークンやトークン設定を替えても、別の人のデータが混ざらない
export const cacheNamespace = (
  kind: CacheKind,
  identity: Pick<Identity, "teamId" | "userId">,
) => `${kind}-${scopeKey(identity)}`;

// トークン自体は保存しない。同じ認証情報の前回結果を探すためのハッシュだけを使う。
export function identityCacheKey(
  settings: Pick<Settings, "accessToken">,
): string {
  return createHash("sha256")
    .update(settings.accessToken.trim())
    .digest("hex")
    .slice(0, 32);
}
const normalizeHandle = (raw: string) => raw.trim().replace(/^@+/, "").trim();

// 自分のハンドルの一覧。auth.test の user と、Previous Handles（カンマ区切り）。重複は除く。
// 古いグループ DM の名前には、作ったときのハンドルが残るので、改名した人は前のハンドルも要る。
// 全角のカンマ（，・、）も区切りにする（日本語入力のまま打たれても、1つのハンドルにならないように）
export function selfHandles(user: string, previousHandles: string): string[] {
  const handles = [user, ...previousHandles.split(/[,，、]/)]
    .map(normalizeHandle)
    .filter((handle) => handle !== "");
  return [...new Set(handles)];
}

export type IdentityFailureKind = "missing-token" | "failed";
export const FAILURE_TITLES: Record<IdentityFailureKind, string> = {
  "missing-token": "Slack Access Tokenを設定してください",
  failed: "Slackに自分の情報を問い合わせられませんでした",
};
export type IdentityFailure = {
  kind: IdentityFailureKind;
  title: string;
  message: string;
};
export type IdentityOutcome =
  | { kind: "ok"; identity: Identity }
  | { kind: "failed"; failure: IdentityFailure };
export const AUTH_TIMEOUT_MS = 30_000;
export async function fetchIdentity(
  settings: Pick<Settings, "accessToken">,
  api: ApiCall = createSlackApi(settings.accessToken),
): Promise<IdentityOutcome> {
  const failure = (
    kind: IdentityFailureKind,
    message: string,
  ): IdentityOutcome => ({
    kind: "failed",
    failure: { kind, title: FAILURE_TITLES[kind], message },
  });
  if (!settings.accessToken.trim())
    return failure(
      "missing-token",
      "拡張の設定のSlack Access Tokenに、自分のUser OAuth Tokenを入れてください",
    );
  try {
    const raw = await api("auth.test", {}, { timeoutMs: AUTH_TIMEOUT_MS });
    if (object(raw).bot_id)
      return failure(
        "failed",
        "Bot Tokenは使用できません。User OAuth Tokenを設定してください",
      );
    const identity = readIdentity({
      userId: raw.user_id,
      user: raw.user,
      teamId: raw.team_id,
      team: raw.team,
      url: raw.url,
    });
    return identity
      ? { kind: "ok", identity }
      : failure("failed", "auth.testの応答を読み取れませんでした");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "failed",
      `${maskTokens(message).replaceAll(settings.accessToken, "***").slice(0, 300)}。Slack Access Tokenと権限を確認してください`,
    );
  }
}
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
export type Session = (
  | { canFetch: true; display: Identity; fetchAs: Identity }
  | { canFetch: false; display: Identity; fetchAs: undefined }
) & { api: ApiCall };

// 出す一覧が無い（前回の結果が無く、今回の auth.test も成功していない）ときは undefined
export function sessionOf(
  decision: FetchDecision,
  api: ApiCall,
): Session | undefined {
  if (decision.canFetch) return { ...decision, api };
  return decision.display
    ? { canFetch: false, display: decision.display, fetchAs: undefined, api }
    : undefined;
}

export type IdentityView = {
  // 取得してよいかと、どの人の名前空間を使うか
  decision: FetchDecision;
  // 今回の auth.test が取れなかった理由
  failure: IdentityFailure | undefined;
  // 今回の auth.test の結果を待っている
  checking: boolean;
};

// 前回の結果と、今回の auth.test の結果（まだなら undefined）から、画面の状態を決める。
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
