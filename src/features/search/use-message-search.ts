import { useCallback, useEffect, useRef, useState } from "react";
import { readPause, writePause } from "./gate-store.ts";
import type { Hit } from "../../slack/hits.ts";
import type { Session } from "../../slack/identity.ts";
import {
  DEBOUNCE_MS,
  decideSearch,
  searchDelay,
  statusForSkipped,
  type SearchStatus,
} from "./search-gate.ts";
import { searchMessages } from "../../slack/slack.ts";

export type MessageSearch = {
  // 結果を出した検索式。結果がまだ無い（検索していない・失敗した・止めている）ときは undefined。
  // 画面は、これといまの検索欄の検索式を比べて、いまの検索語の結果かを見分ける
  query: string | undefined;
  hits: readonly Hit[];
  // 直近の判断と結果（検索した・しなかった・止めている・失敗した）。検索式つき
  status: SearchStatus | undefined;
  isLoading: boolean;
  // 同じ検索式をもう一度検索する。止めている間と、短いときは検索しない
  revalidate: () => void;
};

type State = {
  query?: string;
  hits: Hit[];
  status?: SearchStatus;
  searching: boolean;
};

// 打ち終えてから反映する
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// 中断されたら待たずに戻る
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

// メッセージの検索。打ち終えてから500ミリ秒待って検索し、検索どうしは最短1秒あける。
// 新しい入力が来たら、前の検索は止めて結果を捨てる。1文字・止める期限の内側は検索しない（search-gate）。
// 空・1文字・止めている・失敗のときも、その検索式つきの記録を残す。
// 画面が「待っている選択」を、検索が終わるまで待つのか、捨てるのかを決められるようにするため。
// 検索は、今回の auth.test が成功してから始める（session.canFetch）。それまでは、検索式が変わっても何もしない。
// 自分宛ての検索に使う自分の ID は、取得する人（session.fetchAs）のもの
export function useMessageSearch(
  expression: string,
  session: Session,
): MessageSearch {
  const selfId = session.fetchAs?.userId;
  const debounced = useDebounced(expression, DEBOUNCE_MS);
  const [state, setState] = useState<State>({ hits: [], searching: false });
  const [nonce, setNonce] = useState(0);
  const lastStartedAt = useRef(0);

  useEffect(() => {
    if (selfId === undefined) return;
    const skip = (decision: Parameters<typeof statusForSkipped>[1]) =>
      setState({
        hits: [],
        status: statusForSkipped(debounced, decision),
        searching: false,
      });

    const decision = decideSearch(debounced, readPause("search"), Date.now());
    if (!decision.search) {
      skip(decision);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    // 検索が終わるまで、前の結果は残す（打つたびに一覧が空にならない）
    setState((previous) => ({ ...previous, searching: true }));

    void (async () => {
      await sleep(searchDelay(lastStartedAt.current, Date.now()), signal);
      if (signal.aborted) return;
      // 待つ間に、止める期限ができていないか、もう一度見る
      const again = decideSearch(debounced, readPause("search"), Date.now());
      if (!again.search) {
        skip(again);
        return;
      }

      lastStartedAt.current = Date.now();
      const outcome = await searchMessages(debounced, {
        signal,
        api: session.api,
        selfId,
      });
      // 新しい入力で中断したものは、結果を捨てる
      if (signal.aborted || outcome.kind === "aborted") return;

      if (outcome.kind === "ok") {
        setState({
          query: debounced,
          hits: outcome.hits,
          status: { kind: "ok", query: debounced },
          searching: false,
        });
        return;
      }
      const { failure } = outcome;
      if (failure.pause) {
        // 時間切れ・回数制限。次の検索を止め（閉じて開き直しても止まったまま）、そのことを行に出す
        const pause = writePause("search", failure.pause);
        setState({
          hits: [],
          status: { kind: "paused", query: debounced, pause },
          searching: false,
        });
        return;
      }
      setState({
        hits: [],
        status: { kind: "failed", query: debounced, message: failure.message },
        searching: false,
      });
    })();

    return () => controller.abort();
    // nonce は、同じ検索式をもう一度検索するための合図。取得してよい人（selfId）が決まったら、待たせていた検索を始める
  }, [debounced, nonce, selfId, session.api]);

  const revalidate = useCallback(() => setNonce((n) => n + 1), []);

  return {
    query: state.query,
    hits: state.hits,
    status: state.status,
    isLoading: state.searching,
    revalidate,
  };
}
