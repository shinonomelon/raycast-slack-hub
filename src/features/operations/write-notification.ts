import type { WriteOutcome } from "./write-outcome.ts";

// 送信後の画面終了と認証変更を分け、旧認証の結果を通知へ渡さない。
export async function notifyOwnedWrite(
  pending: Promise<WriteOutcome | undefined>,
  sameAuthentication: () => boolean,
  notify: (outcome: WriteOutcome) => void,
  discard: () => Promise<void>,
): Promise<WriteOutcome | undefined> {
  const outcome = await pending;
  if (!outcome) return undefined;
  if (!sameAuthentication()) {
    await discard();
    return undefined;
  }
  notify(outcome);
  return outcome;
}
