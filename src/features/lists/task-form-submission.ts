import type { WriteOutcome } from "../operations/write-outcome.ts";

// 保存成功後の画面遷移を待つ間も、同じフォームから二度作成させない。
export function createTaskFormSubmission() {
  let state: "idle" | "pending" | "succeeded" | "unconfirmed" = "idle";
  return {
    get canSubmit() {
      return state === "idle";
    },
    get succeeded() {
      return state === "succeeded";
    },
    get unconfirmed() {
      return state === "unconfirmed";
    },
    begin() {
      if (state !== "idle") return false;
      state = "pending";
      return true;
    },
    accept(outcome: WriteOutcome) {
      state = outcome.kind === "failed" ? "idle" : outcome.kind;
    },
    releaseUnstarted() {
      if (state === "pending") state = "idle";
    },
  };
}
