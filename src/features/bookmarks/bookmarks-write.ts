import type { WriteOutcome } from "../operations/write-outcome.ts";

// フォームを閉じても送信済みの結果は親へ返す。画面表示用フックのmount判定より先に呼ぶ。
export async function completeBookmarkWrite(
  action: () => Promise<WriteOutcome>,
  onWritten: (outcome: WriteOutcome) => Promise<boolean>,
): Promise<{ outcome: WriteOutcome; refreshed: boolean }> {
  const outcome = await action();
  let refreshed = false;
  if (outcome.kind !== "failed") {
    try {
      refreshed = await onWritten(outcome);
    } catch {
      // 読取や表示の問題で、確定した書き込みを失敗に変えない。
    }
  }
  return { outcome, refreshed };
}
