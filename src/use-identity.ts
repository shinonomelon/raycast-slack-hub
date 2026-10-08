import { Cache } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
  decideFetch,
  fetchIdentity,
  identityCacheKey,
  identityView,
  readIdentity,
  type Identity,
  type IdentityOutcome,
  type IdentityView,
} from "./identity.ts";
import { migrateLegacyMarks } from "./read-state.ts";
import { readSettings, type Settings } from "./settings.ts";

// 前回の whoami の結果。slack-cli の場所とプロファイルの組ごとに持つ（キーはパスの記号を含まないハッシュ）。
// 開いた直後に、その人の保存した一覧を出すために使う。名前空間を分けるのは、directory.ts の Cache と同じ理由
const cache = new Cache({ namespace: "identity" });

function loadPrevious(key: string): Identity | undefined {
  const raw = cache.get(key);
  if (!raw) return undefined;
  try {
    return readIdentity(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// 保存できなくても、この回の画面は続ける（次に開いたとき、前回の結果が無いものとして待つ）
function savePrevious(key: string, identity: Identity): void {
  try {
    cache.set(key, JSON.stringify(identity));
  } catch {
    // 保存できなかっただけ
  }
}

export type IdentityState = IdentityView & {
  // 開いたときに読んだ設定
  settings: Settings;
};

// 開くたびに whoami を呼んで、自分の情報（ワークスペースの ID・自分の ID・ハンドル）を取る。
// 取得してよいかと、どの人の名前空間を使うかは、decideFetch（identity.ts）が決める（decision）。
// 取れるまでの間と、取れなかったときは、前回の結果（あれば）の人の保存した一覧を出してよいが、
// Slack から取るのは、今回の whoami が成功してから（decision.canFetch が true になってから）。
// 今回の結果が前回と違えば、表示する人が新しい人に替わる（画面は、新しい人の名前空間に切り替える）
export function useIdentity(): IdentityState {
  // 設定は、開いたときに1回読む（whoami と、そのあとの取得が、同じ設定で動くように）
  const [settings] = useState(readSettings);
  const key = useMemo(() => identityCacheKey(settings), [settings]);
  const [previous] = useState(() => loadPrevious(key));
  const [outcome, setOutcome] = useState<IdentityOutcome>();

  useEffect(() => {
    let alive = true;
    void fetchIdentity(settings).then((result) => {
      // 今回の whoami が成功した人（decideFetch が取得と書き込みを許す人）についてだけ、次の2つをする
      const decision = decideFetch(previous, result);
      if (decision.canFetch) {
        const { fetchAs } = decision;
        // 更新の前に付けた印を、この人の名前空間へ一度だけ移す（移すかの判断は marks-migration.ts）。
        // 画面がこの人の印を最初に読む前に済ませる（前回の結果が無いときは、setOutcome のあとに画面ができる）
        migrateLegacyMarks(fetchAs);
        // 閉じたあとでも、取れた結果は次に開いたときのために保存する
        if (JSON.stringify(fetchAs) !== JSON.stringify(previous)) {
          savePrevious(key, fetchAs);
        }
      }
      if (alive) setOutcome(result);
    });
    return () => {
      alive = false;
    };
    // 開いたときに1回だけ呼ぶ
  }, []);

  const view = useMemo(
    () => identityView(previous, outcome),
    [previous, outcome],
  );
  return useMemo(() => ({ ...view, settings }), [view, settings]);
}
