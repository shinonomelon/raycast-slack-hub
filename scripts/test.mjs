import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// シェルの glob に頼らず、すべての機能フォルダからテストを集める。
const files = readdirSync("src", { recursive: true })
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `src/${file}`)
  .sort();
if (files.length === 0) throw new Error("No tests found");

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    ...process.argv.slice(2),
    ...files,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
