import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as gate from "./search-gate.ts";

test("account検索停止は旧globalと合流し別accountの期限を混ぜず、保存失敗でも停止", () => {
  const entries = new Map<string, string>();
  let fail = false;
  class Cache {
    get(key: string) {
      return entries.get(key);
    }
    set(key: string, value: string) {
      if (fail) throw new Error("disk");
      entries.set(key, value);
    }
  }
  const exports: Record<
    string,
    (...args: unknown[]) => gate.Pause | undefined
  > = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/search/gate-store.ts", "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    {
      exports,
      require: (id: string) => (id === "@raycast/api" ? { Cache } : gate),
      Map,
      Date,
    },
  );
  const now = Date.now();
  exports.writePause("search", { until: now + 10000, cause: "timeout" });
  exports.writeAccountSearchPause("T1-U1", {
    until: now + 30000,
    cause: "rate_limited",
  });
  assert.equal(
    exports.readAccountSearchPause("T1-U1", now)?.until,
    now + 30000,
  );
  assert.equal(
    exports.readAccountSearchPause("T2-U2", now)?.until,
    now + 10000,
  );
  fail = true;
  exports.writeAccountSearchPause("T2-U2", {
    until: now + 60000,
    cause: "rate_limited",
  });
  assert.equal(
    exports.readAccountSearchPause("T2-U2", now)?.until,
    now + 60000,
  );
  assert.equal(exports.readAccountSearchPause("T1-U1", now + 40000), undefined);
});
