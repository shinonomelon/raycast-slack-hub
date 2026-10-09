// 背景の取り直しの流れ。@raycast/api を読み込まないので、node のテストから動かせる
// （auth.test・取り直し・出力は引数で受け取る。refresh-directory.ts が本物をつなぐ）
import type { Identity, IdentityOutcome } from "./identity.ts";

// 背景の取り直しの判断（進め方）
export type RefreshPlan =
  // 何もせずに終える。log が理由（console.log に出す）。throw しない・Cache に書かない
  | { action: "skip"; log: string }
  // この人（ワークスペースと自分の ID）の名前空間で、古くなった一覧を取り直す
  | { action: "refresh"; identity: Identity };

// auth.test の結果から、取り直すか、何もせずに終えるかを決める。
// 取れなかったとき（トークンが未設定・無効など）に何かを取ると、前回までと違う人の一覧で
// Cache を上書きしうる。5分おきに動くので、投げて失敗を積み上げることもしない。
// refreshAll は、必ずこの判断を通してから取り直す
export function planRefresh(outcome: IdentityOutcome): RefreshPlan {
  if (outcome.kind === "failed") {
    return {
      action: "skip",
      log: `skipped ${outcome.failure.title}: ${outcome.failure.message}`,
    };
  }
  return { action: "refresh", identity: outcome.identity };
}

// 自分の情報を取ってから、古くなった一覧を取り直す。
// 取れなければ、Slack のデータを取らず、保存もせず、理由を出して終える（planRefresh）。
// 取れたら、その人の一覧を、1つずつ取り直す
export async function refreshAll<D extends { key: string }>(params: {
  fetchIdentity: () => Promise<IdentityOutcome>;
  dirs: readonly D[];
  // 古くなっていれば取り直して保存し、取り直したかを返す
  refresh: (dir: D, identity: Identity) => Promise<boolean>;
  log: (line: string) => void;
}): Promise<void> {
  const { fetchIdentity, dirs, refresh, log } = params;
  const plan = planRefresh(await fetchIdentity());
  if (plan.action === "skip") {
    log(plan.log);
    return;
  }

  // 1つが失敗しても、ほかの取得（特に時間のかかる人の取得）を最後まで終わらせてから終える。
  // Promise.all だと最初の失敗でコマンドが終わり、実行中の取得が止まるおそれがある
  const results = await Promise.allSettled(
    dirs.map((dir) => refresh(dir, plan.identity)),
  );
  log(
    `refreshed ${results
      .map(
        (r, i) =>
          `${dirs[i].key}=${r.status === "fulfilled" ? r.value : "failed"}`,
      )
      .join(" ")}`,
  );
  const failures = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [
          `${dirs[i].key}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        ]
      : [],
  );
  // 失敗は握り潰さず、全部終わってからまとめてコマンドの失敗として返す
  if (failures.length) throw new Error(failures.join("\n"));
}
