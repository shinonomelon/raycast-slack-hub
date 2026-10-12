export type DirectoryWait = {
  status: "idle" | "loading" | "complete" | "pending" | "busy" | "failed";
  retryAt?: number;
};
// 保存済み一覧を使えるときは、取得待ちを空の検索結果に持ち込まない。
export function emptyDirectoryWait(
  directories: readonly (DirectoryWait & { data?: unknown })[],
): DirectoryWait | undefined {
  const missing = directories.filter(
    (directory) => directory.data === undefined,
  );
  const pending = missing.find((directory) => directory.status === "pending");
  if (pending) return { status: "pending", retryAt: pending.retryAt };
  const busy = missing.find(
    (directory) =>
      directory.status === "busy" || directory.status === "loading",
  );
  return busy ? { status: busy.status } : undefined;
}
