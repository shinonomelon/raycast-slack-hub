import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { normalizeMatch, type Hit } from "../../slack/hits.ts";
import { createTriageFetchers } from "./triage-fetch.ts";
import { messageDetailBody } from "../hub/message-detail.ts";

// Cacheだけをメモリの偽物にし、実際の保存・読込の境界を確認する。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@raycast/api"
      ? { url: "full-text-test:raycast-api", shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return url === "full-text-test:raycast-api"
      ? {
          format: "module",
          shortCircuit: true,
          source: `
            const namespaces = new Map();
            export class Cache {
              constructor({ namespace }) {
                if (!namespaces.has(namespace)) namespaces.set(namespace, new Map());
                this.values = namespaces.get(namespace);
              }
              get(key) { return this.values.get(key); }
              set(key, value) { this.values.set(key, value); }
            }
          `,
        }
      : nextLoad(url, context);
  },
});
const modules = Promise.all([
  import("./read-state.ts"),
  import("@raycast/api"),
]).finally(() => hooks.deregister());

const hit = (text: string): Hit => ({
  key: "C1:1700000001.000000",
  channelId: "C1",
  ts: "1700000001.000000",
  permalink: "",
  text,
  channelKind: "channel",
  mentionsSelf: true,
});

test("保存は300文字のプレビューだけに制限し、メモリ上の全文と境目を変えない", async () => {
  const [{ createReadState }, { Cache }] = await modules;
  const store = createReadState("full-text-write");
  const cache = new Cache({ namespace: "full-text-write" });
  const body = `${"あ".repeat(400)} 保存しない末尾`;
  const original = hit(body);
  const entry = {
    at: 5,
    hits: [original],
    cappedBefore: "1700000300.000000",
  };
  store.saveTriage(entry);

  const saved = cache.get("triage") ?? "";
  assert.equal(saved.includes("保存しない末尾"), false);
  assert.equal(JSON.parse(saved).hits[0].text, `${body.slice(0, 300)}…`);
  assert.equal(original.text, body);
  assert.equal(entry.hits[0], original);
  assert.equal(entry.cappedBefore, "1700000300.000000");
  const loaded = store.loadTriage();
  assert.equal(loaded?.hits[0].text, `${body.slice(0, 300)}…`);
  assert.deepEqual(loaded?.hits[0], {
    ...original,
    text: `${body.slice(0, 300)}…`,
    textIsPreview: true,
  });
  assert.equal(loaded?.cappedBefore, entry.cappedBefore);
});

test("300文字までの本文は省略せず、旧キャッシュの切れた本文だけにプレビューの印を付ける", async () => {
  const [{ createReadState }, { Cache }] = await modules;
  const store = createReadState("full-text-legacy");
  const cache = new Cache({ namespace: "full-text-legacy" });
  for (const text of [
    "",
    "短い本文",
    "あ".repeat(300),
    `${"あ".repeat(300)}…`,
  ]) {
    const legacy = { at: 5, hits: [hit(text)] };
    cache.set("triage", JSON.stringify(legacy));
    assert.deepEqual(store.loadTriage(), {
      ...legacy,
      hits: [
        {
          ...legacy.hits[0],
          ...(text.length === 301 && { textIsPreview: true }),
        },
      ],
    });
  }
  store.saveTriage({ at: 5, hits: [hit("あ".repeat(300))] });
  assert.equal(JSON.parse(cache.get("triage") ?? "").hits[0].text.length, 300);
});

test("自分宛ての取得結果は保存後も全文を表示し、保存結果の再利用とReload Searchを区別する", async () => {
  const [{ createReadState }] = await modules;
  const store = createReadState("full-text-reload");
  const now = 1_700_000_100_000;
  const body = `${"あ".repeat(400)} <@U1> 本文の末尾`;
  const full = normalizeMatch(
    { ts: "1700000001.000000", channel: { id: "C1" }, text: body },
    "U1",
  );
  assert.ok(full);
  let calls = 0;
  const fetchers = createTriageFetchers({
    ...store,
    selfId: "U1",
    now: () => now,
    readPause: () => undefined,
    writePause: (_kind, pause) => pause,
    forgottenAt: store.lastReadForgottenAt,
    searchPage: async () => {
      calls += 1;
      return { kind: "ok", hits: [full], capped: false };
    },
    getLastReads: async () => ({ kind: "ok", rows: [] }),
  });
  const names = { user: () => "本人", channel: () => "会話" };

  const fresh = await fetchers.fetchMentions(false);
  assert.equal(fresh.kind, "ok");
  if (fresh.kind !== "ok") return;
  assert.equal(fresh.value.hits[0].text, body);
  assert.equal(fresh.value.hits[0].textIsPreview, undefined);
  assert.equal(
    messageDetailBody(fresh.value.hits[0], names),
    `${"あ".repeat(400)} @本人 本文の末尾`,
  );
  assert.equal(calls, 2);

  const cached = await fetchers.fetchMentions(false);
  assert.equal(cached.kind, "ok");
  if (cached.kind !== "ok") return;
  assert.equal(cached.value.hits[0].text, `${body.slice(0, 300)}…`);
  assert.equal(cached.value.hits[0].textIsPreview, true);
  assert.ok(
    messageDetailBody(cached.value.hits[0], names).startsWith(
      "プレビュー（⌘Rで全文を取得）",
    ),
  );
  assert.equal(calls, 2);

  const reloaded = await fetchers.fetchMentions(true);
  assert.equal(reloaded.kind, "ok");
  if (reloaded.kind !== "ok") return;
  assert.equal(reloaded.value.hits[0].text, body);
  assert.equal(reloaded.value.hits[0].textIsPreview, undefined);
  assert.equal(calls, 4);
  assert.equal(store.loadTriage()?.hits[0].text, `${body.slice(0, 300)}…`);
});
