import { useCallback, useEffect, useRef, useState } from "react";
import {
  readAccountSearchPause,
  writeAccountSearchPause,
} from "./gate-store.ts";
import type { Hit } from "../../slack/hits.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import {
  DEBOUNCE_MS,
  decideSearch,
  searchDelay,
  statusForSkipped,
  type SearchStatus,
} from "./search-gate.ts";
import { searchPage } from "../../slack/slack.ts";
import type { MessageSearchPlan } from "../search-scope/search-plan.ts";
import {
  createMessageScan,
  messagePlanKey,
  type MessageScanSnapshot,
} from "./message-scan.ts";

export type MessageSearch = {
  query: string | undefined;
  hits: readonly Hit[];
  status: SearchStatus | undefined;
  isLoading: boolean;
  revalidate: () => void;
  continueSearch: () => void;
  planKey: string;
  progress: MessageScanSnapshot | undefined;
};
type State = {
  key: string;
  query?: string;
  hits: Hit[];
  status?: SearchStatus;
  searching: boolean;
  progress?: MessageScanSnapshot;
};
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
// 入力そのものと範囲指紋で即時中断し、取得の開始だけをdebounceする。
export function useMessageSearch(
  expression: string,
  session: Session,
  plan?: MessageSearchPlan,
): MessageSearch {
  const selfId = session.canFetch ? session.fetchAs?.userId : undefined;
  const account = scopeKey(session.display);
  const planKey = messagePlanKey(expression, plan);
  const inputKey = JSON.stringify([account, planKey, selfId]);
  const [state, setState] = useState<State>({
    key: inputKey,
    hits: [],
    searching: false,
  });
  const [request, setRequest] = useState({
    key: inputKey,
    nonce: 0,
    continue: false,
  });
  const lastStartedAt = useRef(0);
  const scan = useRef<
    { key: string; value: ReturnType<typeof createMessageScan> } | undefined
  >(undefined);
  const generation = useRef(0);
  const latest = useRef({ expression, plan, inputKey });
  latest.current = { expression, plan, inputKey };
  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    const { signal } = controller;
    const current = latest.current;
    // 空欄や認証待ちへ変わった場合も、前の入力の取得状態を再利用しない。
    if (scan.current?.key !== current.inputKey) scan.current = undefined;
    const continuing =
      request.continue &&
      request.key === current.inputKey &&
      scan.current?.key === current.inputKey;
    const valid = () =>
      !signal.aborted &&
      generation.current === id &&
      latest.current.inputKey === current.inputKey;
    if (!selfId) {
      setState({ key: current.inputKey, hits: [], searching: false });
      return () => controller.abort();
    }
    const skip = (status: SearchStatus) => {
      if (valid())
        setState((previous) => ({
          ...(status.kind === "paused" && previous.key === current.inputKey
            ? previous
            : { key: current.inputKey, hits: [] }),
          status,
          searching: false,
        }));
    };
    if (current.plan && !current.plan.canSearch) {
      skip(
        current.plan.conflicts.length
          ? {
              kind: "failed",
              query: expression,
              message: current.plan.conflicts.join("・"),
            }
          : { kind: "skipped", query: expression, reason: "empty" },
      );
      scan.current = undefined;
      return () => controller.abort();
    }
    const structured =
      current.plan &&
      (current.plan.scope.channelIds !== "all" || current.plan.scope.senderId);
    const gateQuery = structured ? "条件検索" : expression;
    const decision = decideSearch(
      gateQuery,
      readAccountSearchPause(account),
      Date.now(),
    );
    if (!decision.search && !continuing) {
      skip(statusForSkipped(expression, decision));
      return () => controller.abort();
    }
    setState((old) => ({
      ...(old.key === current.inputKey
        ? old
        : { key: current.inputKey, hits: [] }),
      searching: true,
    }));
    void (async () => {
      await sleep(
        Math.max(DEBOUNCE_MS, searchDelay(lastStartedAt.current, Date.now())),
        signal,
      );
      if (!valid()) return;
      if (!continuing || scan.current?.key !== current.inputKey) {
        scan.current = {
          key: current.inputKey,
          value: createMessageScan(expression, current.plan, {
            search: (query, page, requestSignal, timeoutMs) =>
              searchPage(query, {
                signal: requestSignal,
                api: session.api,
                selfId,
                page,
                timeoutMs,
              }),
            readPause: () => readAccountSearchPause(account),
            writePause: (pause) => writeAccountSearchPause(account, pause),
          }),
        };
      }
      lastStartedAt.current = Date.now();
      const progress = await scan.current.value.run(signal);
      if (!valid()) return;
      const status: SearchStatus =
        progress.pausedUntil > Date.now()
          ? {
              kind: "paused",
              query: expression,
              pause: readAccountSearchPause(account) ?? {
                until: progress.pausedUntil,
                cause: "rate_limited",
              },
            }
          : progress.failure
            ? {
                kind: "failed",
                query: expression,
                message: progress.failure.message,
              }
            : { kind: "ok", query: expression };
      setState({
        key: current.inputKey,
        query: expression,
        hits: progress.hits,
        progress,
        status,
        searching: false,
      });
    })().catch(() => {
      if (valid())
        skip({
          kind: "failed",
          query: expression,
          message: "検索に失敗しました。更新して再試行してください",
        });
    });
    return () => controller.abort();
  }, [expression, planKey, inputKey, request, selfId, account, session.api]);
  const revalidate = useCallback(
    () =>
      setRequest((old) => ({
        key: inputKey,
        nonce: old.nonce + 1,
        continue: false,
      })),
    [inputKey],
  );
  const continueSearch = useCallback(
    () =>
      setRequest((old) => ({
        key: inputKey,
        nonce: old.nonce + 1,
        continue: true,
      })),
    [inputKey],
  );
  const current = state.key === inputKey;
  return {
    query: current ? state.query : undefined,
    hits: current ? state.hits : [],
    status: current ? state.status : undefined,
    isLoading: current && state.searching,
    revalidate,
    continueSearch,
    planKey,
    progress: current ? state.progress : undefined,
  };
}
