import test from "node:test";
import assert from "node:assert/strict";
import { createReplyPriorityStore } from "./reply-priority-store.ts";
import { MARK_TTL } from "./reply-priority.ts";
test("保存は印とpauseのみ、本人境界と期限、取消", () => {
  const map = new Map<string, string>();
  const cache = {
    get: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v);
    },
  };
  let at = 1000;
  const a = createReplyPriorityStore(cache, "T:A", () => at);
  const b = createReplyPriorityStore(cache, "T:B", () => at);
  a.set("candidate", { kind: "dismissed", anchorTs: "150.000000", at });
  assert.equal(Object.keys(b.load()).length, 0);
  assert.equal(Object.keys(a.load()).length, 1);
  a.remove("candidate");
  assert.equal(Object.keys(a.load()).length, 0);
  a.set("candidate", {
    kind: "snoozed",
    anchorTs: "150.000000",
    at,
    until: at + MARK_TTL + 1,
  });
  a.savePause(3000);
  assert.equal(a.loadPause(), 3000);
  at += MARK_TTL;
  assert.equal(Object.keys(a.load()).length, 0);
  assert.equal(a.loadPause(), 0);
  assert.ok(
    [...map.values()].every((v) => !v.includes("text") && !v.includes("token")),
  );
});
