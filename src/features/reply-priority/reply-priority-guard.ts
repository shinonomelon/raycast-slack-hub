export type ReplyCredentials = { token: string; aiKey: string };
export type ReplyRecheckState = {
  generation: number;
  anchorTs: string;
  signal: AbortSignal;
};
export async function guardedReplyRecheck<T>(
  read: () => ReplyRecheckState | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<
  { kind: "ok"; value: T } | { kind: "failed"; error: unknown } | undefined
> {
  const captured = read();
  if (!captured || captured.signal.aborted) return undefined;
  let outcome: { kind: "ok"; value: T } | { kind: "failed"; error: unknown };
  try {
    outcome = { kind: "ok", value: await request(captured.signal) };
  } catch (error) {
    outcome = { kind: "failed", error };
  }
  const current = read();
  return current &&
    !captured.signal.aborted &&
    current.generation === captured.generation &&
    current.anchorTs === captured.anchorTs
    ? outcome
    : undefined;
}

// 一度設定が変わったセッションは、値を元に戻しても再開しない。
export function createReplyCredentialGate(
  original: ReplyCredentials,
  read: () => ReplyCredentials,
  invalidate: () => void,
) {
  let invalidated = false;
  return {
    check() {
      if (invalidated) return false;
      const current = read();
      if (
        current.token !== original.token ||
        current.aiKey !== original.aiKey
      ) {
        invalidated = true;
        invalidate();
        return false;
      }
      return true;
    },
  };
}
