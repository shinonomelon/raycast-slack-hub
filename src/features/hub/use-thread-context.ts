import { useEffect, useRef, useState } from "react";
import type { Session } from "../../slack/identity.ts";
import type { Hit } from "../../slack/hits.ts";
import {
  cachedThreadContext,
  fetchThreadContext,
  threadContextKey,
  ThreadContextError,
  type ThreadContext,
  type ThreadFailure,
} from "./thread-context.ts";

export type ThreadDetail = {
  data?: ThreadContext;
  loading: boolean;
  failure?: ThreadFailure;
  more: () => void;
  refresh: () => void;
};
type Result = {
  key: string;
  api: Session["api"];
  data?: ThreadContext;
  loading: boolean;
  failure?: ThreadFailure;
};

// フックは一覧に1つだけ置き、選択中のメッセージだけを渡す。
export function useThreadContext(
  session: Session,
  hit: Hit | undefined,
  opened: boolean,
): ThreadDetail {
  const active = opened && session.canFetch && hit !== undefined;
  const key = hit ? threadContextKey(session, hit) : "";
  const [result, setResult] = useState<Result>();
  const [operation, setOperation] = useState<{
    id: number;
    mode: "initial" | "more" | "refresh";
    key?: string;
    api?: Session["api"];
  }>({ id: 0, mode: "initial" });
  const running = useRef(false);
  const generation = useRef(0);
  const consumedOperation = useRef(0);
  const current = useRef(result);
  current.current = result;
  useEffect(() => {
    const id = ++generation.current;
    if (!active || !hit) {
      running.current = false;
      return;
    }
    const prior =
      current.current?.key === key && current.current.api === session.api
        ? current.current
        : undefined;
    const cached = cachedThreadContext(session, hit);
    const mode =
      operation.id !== consumedOperation.current &&
      operation.key === key &&
      operation.api === session.api
        ? operation.mode
        : "initial";
    consumedOperation.current = operation.id;
    const data =
      mode === "more"
        ? (prior?.data ?? cached)
        : mode === "refresh"
          ? undefined
          : cached;
    if (mode === "initial" && data) {
      running.current = false;
      setResult({ key, api: session.api, data, loading: false });
      return;
    }
    const controller = new AbortController();
    running.current = true;
    setResult({
      key,
      api: session.api,
      data: data ?? prior?.data,
      loading: true,
    });
    const start = () => {
      void fetchThreadContext(session, hit, data, controller.signal)
        .then((data) => {
          if (generation.current !== id || controller.signal.aborted) return;
          running.current = false;
          setResult({ key, api: session.api, data, loading: false });
        })
        .catch((error) => {
          if (generation.current !== id || controller.signal.aborted) return;
          running.current = false;
          setResult({
            key,
            api: session.api,
            data: data ?? prior?.data,
            loading: false,
            failure:
              error instanceof ThreadContextError
                ? error.failure
                : { kind: "failed" },
          });
        });
    };
    const timer = mode === "initial" ? setTimeout(start, 250) : undefined;
    if (mode !== "initial") start();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      running.current = false;
    };
  }, [active, key, session.api, operation.id]);
  const visible =
    active && result?.key === key && result.api === session.api
      ? result
      : undefined;
  const request = (mode: "more" | "refresh") => {
    if (
      !active ||
      running.current ||
      (visible?.failure?.retryAt ?? 0) > Date.now()
    )
      return;
    running.current = true;
    setOperation((old) => ({ id: old.id + 1, mode, key, api: session.api }));
  };
  return {
    data: visible?.data,
    loading: active && (visible?.loading ?? true),
    failure: visible?.failure,
    more: () => request("more"),
    refresh: () => request("refresh"),
  };
}
