import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDirectoryWait } from "./directory-state.ts";
test("初回の他実行取得中と延期は、取得完了後も空結果として表示しない", () => {
  assert.deepEqual(emptyDirectoryWait([{ status: "busy" }]), {
    status: "busy",
  });
  assert.deepEqual(emptyDirectoryWait([{ status: "pending", retryAt: 1234 }]), {
    status: "pending",
    retryAt: 1234,
  });
  assert.deepEqual(emptyDirectoryWait([{ status: "loading" }]), {
    status: "loading",
  });
});
test("保存済み一覧がある待機と完成した空一覧は通常の表示を保つ", () => {
  assert.equal(
    emptyDirectoryWait([{ status: "pending", data: [] }]),
    undefined,
  );
  assert.equal(
    emptyDirectoryWait([{ status: "complete", data: [] }]),
    undefined,
  );
  assert.equal(emptyDirectoryWait([{ status: "failed" }]), undefined);
  assert.deepEqual(
    emptyDirectoryWait([
      { status: "complete", data: [] },
      { status: "pending", retryAt: 10 },
    ]),
    { status: "pending", retryAt: 10 },
  );
});
