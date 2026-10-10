import { useEffect, useRef, useState } from "react";
import { showToast, Toast } from "@raycast/api";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { createWriteLock, type WriteOutcome } from "./write-outcome.ts";
import { notifyOwnedWrite } from "./write-notification.ts";

export function useWriteOperation(session: Session) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome>();
  const key = scopeKey(session.display);
  const current = useRef({ api: session.api, key, canFetch: session.canFetch });
  current.current = { api: session.api, key, canFetch: session.canFetch };
  const mounted = useRef(true);
  const lock = useRef(createWriteLock());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 認証が変わった画面で、以前の未確認状態を新しい認証の操作と混ぜない。
  useEffect(() => {
    lock.current = createWriteLock();
    setOutcome(undefined);
    setBusy(false);
  }, [session.api, key]);

  async function run(action: () => Promise<WriteOutcome>) {
    if (
      !current.current.canFetch ||
      lock.current.busy ||
      lock.current.unconfirmed
    )
      return undefined;
    const owner = current.current;
    const writeLock = lock.current;
    setBusy(true);
    let toast: Toast | undefined;
    const ownsOperation = () =>
      mounted.current &&
      current.current.api === owner.api &&
      current.current.key === owner.key &&
      current.current.canFetch;
    // toastの待機より先に同期ロックを取る。待機中の二度押しや認証変更でも送信しない。
    const pending = writeLock.run(async () => {
      toast = await showToast({
        style: Toast.Style.Animated,
        title: "変更を保存しています",
      });
      if (!ownsOperation())
        return {
          kind: "failed",
          message: "画面または認証が変わったため、変更は実行していません。",
        };
      return action();
    });
    const sameAuthentication = () =>
      current.current.api === owner.api &&
      current.current.key === owner.key &&
      current.current.canFetch;
    // 画面を閉じても同じ認証の送信結果は通知する。別認証へは旧結果を表示しない。
    const result = await notifyOwnedWrite(
      pending,
      sameAuthentication,
      (outcome) => {
        if (!toast) return;
        toast.style =
          outcome.kind === "succeeded"
            ? Toast.Style.Success
            : Toast.Style.Failure;
        toast.title =
          outcome.kind === "succeeded"
            ? "変更を保存しました"
            : outcome.kind === "unconfirmed"
              ? "変更結果は未確認です"
              : "変更に失敗しました";
        if (outcome.kind !== "succeeded") toast.message = outcome.message;
      },
      async () => {
        if (toast) await toast.hide();
      },
    );
    if (!result) {
      if (
        mounted.current &&
        current.current.api === owner.api &&
        current.current.key === owner.key
      )
        setBusy(false);
      return undefined;
    }
    if (
      !mounted.current ||
      current.current.api !== owner.api ||
      current.current.key !== owner.key ||
      !current.current.canFetch
    )
      return undefined;
    setOutcome(result);
    setBusy(false);
    return result;
  }

  return { run, busy, unconfirmed: outcome?.kind === "unconfirmed", outcome };
}
