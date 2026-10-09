import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheNamespace,
  decideFetch,
  fetchIdentity,
  FAILURE_TITLES,
  identityCacheKey,
  identityView,
  maskTokens,
  readIdentity,
  scopeKey,
  selfHandles,
  sessionOf,
  AUTH_TIMEOUT_MS,
  type Identity,
  type IdentityFailureKind,
  type IdentityOutcome,
} from "./identity.ts";
import { SlackApiError, type ApiCall } from "./slack-api.ts";
const ME: Identity = {
  userId: "U0000000017",
  user: "taro_y",
  teamId: "T0000000012",
  team: "Example Inc",
  url: "https://example.slack.com/",
};
const api: ApiCall = async () => ({ ok: true });
test("項目が欠けている・形が違うときは、読めないものとして扱う", () => {
  for (const missing of ["userId", "user", "teamId", "team", "url"]) {
    const fields: Record<string, unknown> = { ...ME };
    delete fields[missing];
    assert.equal(readIdentity(fields), undefined, `${missing} が欠けている`);
  }
  const bad: [string, unknown][] = [
    ["userId", 12345],
    ["userId", ""],
    ["userId", null],
    ["teamId", ["T1"]],
    ["teamId", ""],
    ["user", ""],
    ["user", "   "],
    ["team", 7],
    ["url", ""],
  ];
  for (const [field, value] of bad) {
    assert.equal(
      readIdentity({ ...ME, [field]: value }),
      undefined,
      `${field}=${JSON.stringify(value)}`,
    );
  }
  for (const value of [null, undefined, 42, "text", true, [], [ME]]) {
    assert.equal(readIdentity(value), undefined, JSON.stringify(value));
  }
});

test("ID は Cache の名前空間（フォルダの名前）に入るので、記号・空白・パスの区切りを含むものは読めないものとして扱う", () => {
  for (const id of [
    "../U1",
    "U1/../../x",
    "U1/2",
    "U1:2",
    "U 1",
    "U1-2",
    "..",
    "U1\n",
    "ユーザー",
  ]) {
    assert.equal(readIdentity({ ...ME, userId: id }), undefined, id);
    assert.equal(readIdentity({ ...ME, teamId: id }), undefined, id);
  }
  // 英数字だけなら読める（Slack の ID の形）
  assert.ok(readIdentity({ ...ME, userId: "W0A1B2C3D4", teamId: "E0A1B2" }));
});

test("Cache の名前空間に teamId と userId が入り、種類ごとに別になる。コロンもパスの区切りも使わない", () => {
  assert.equal(scopeKey(ME), "T0000000012-U0000000017");
  assert.equal(
    cacheNamespace("directory", ME),
    "directory-T0000000012-U0000000017",
  );
  assert.equal(
    cacheNamespace("messages", ME),
    "messages-T0000000012-U0000000017",
  );
  // 種類（directory と messages）は、同じ名前空間に入れない（索引を上書きし合って一覧を失うため）
  assert.notEqual(
    cacheNamespace("directory", ME),
    cacheNamespace("messages", ME),
  );
  for (const kind of ["directory", "messages"] as const) {
    assert.ok(!/[:/\\\s]/.test(cacheNamespace(kind, ME)), kind);
  }
});

test("人（ワークスペースか自分の ID）が違えば、名前空間も違う。自分の情報が決まる前の名前空間（directory・messages）は使わない", () => {
  const otherUser = { ...ME, userId: "U0000000014" };
  const otherTeam = { ...ME, teamId: "T0000000011" };
  for (const kind of ["directory", "messages"] as const) {
    const base = cacheNamespace(kind, ME);
    assert.notEqual(cacheNamespace(kind, otherUser), base);
    assert.notEqual(cacheNamespace(kind, otherTeam), base);
    assert.notEqual(
      cacheNamespace(kind, otherUser),
      cacheNamespace(kind, otherTeam),
    );
    // 古い名前空間の中身は、読まない・書かない（消さない）。新しい名前空間は、その名前にならない
    assert.notEqual(base, kind);
  }
});

test("自分のハンドルの一覧は、auth.test の user と Previous Handles。前後の空白と先頭の @ を除き、重複を除く", () => {
  assert.deepEqual(selfHandles("taro_y", ""), ["taro_y"]);
  assert.deepEqual(selfHandles("taro_y", "old_taro"), ["taro_y", "old_taro"]);
  assert.deepEqual(selfHandles("taro_y", " old_taro , @older_taro ,, @ "), [
    "taro_y",
    "old_taro",
    "older_taro",
  ]);
  // 重複（user と同じ、前のハンドルどうし）は1つにする。順は、user・前のハンドルの順
  assert.deepEqual(selfHandles("taro_y", "old_taro,@taro_y,old_taro"), [
    "taro_y",
    "old_taro",
  ]);
  assert.deepEqual(selfHandles("@taro_y ", "@@old_taro"), [
    "taro_y",
    "old_taro",
  ]);
});

test("Previous Handles は、全角のカンマ（，・、）でも区切る", () => {
  assert.deepEqual(selfHandles("taro_y", "old_a，old_b、old_c"), [
    "taro_y",
    "old_a",
    "old_b",
    "old_c",
  ]);
});

test("前回認証のキーはトークンごとに分かれ、生トークンを含まない", () => {
  const key = identityCacheKey({ accessToken: "xoxp-first" });
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(identityCacheKey({ accessToken: " xoxp-first " }), key);
  assert.notEqual(identityCacheKey({ accessToken: "xoxp-second" }), key);
});
test("auth.testの5項目をIdentityへ変換し、認証に使ったAPIクライアントを呼ぶ", async () => {
  const call: ApiCall = async (method, params, options) => {
    assert.equal(method, "auth.test");
    assert.deepEqual(params, {});
    assert.equal(options?.timeoutMs, AUTH_TIMEOUT_MS);
    return {
      ok: true,
      user_id: ME.userId,
      user: ME.user,
      team_id: ME.teamId,
      team: ME.team,
      url: ME.url,
      token: "not-saved",
    };
  };
  assert.deepEqual(await fetchIdentity({ accessToken: "xoxp-test" }, call), {
    kind: "ok",
    identity: ME,
  });
});
test("未設定・bot・不正な認証応答では取得を始めない", async () => {
  let calls = 0;
  const call: ApiCall = async () => {
    calls++;
    return { ok: true };
  };
  const missing = await fetchIdentity({ accessToken: "" }, call);
  assert.equal(missing.kind, "failed");
  assert.equal(calls, 0);
  for (const raw of [
    { ok: true, bot_id: "B1" },
    { ok: true, user_id: "U1" },
  ]) {
    const result = await fetchIdentity(
      { accessToken: "xoxp-test" },
      async () => raw,
    );
    assert.equal(result.kind, "failed");
    assert.equal(decideFetch(ME, result).canFetch, false);
  }
});
test("認証失敗の表示と保存にトークンを含めない", async () => {
  const token = "xoxp-secret";
  const result = await fetchIdentity({ accessToken: token }, async () => {
    throw new SlackApiError(
      "api",
      `invalid_auth ${token}`,
      undefined,
      "invalid_auth",
    );
  });
  assert.equal(result.kind, "failed");
  assert.ok(!JSON.stringify(result).includes(token));
  for (const text of [
    "xoxp-secret",
    "xoxb-secret",
    "xapp-secret",
    "xoxe.xoxp-secret",
  ])
    assert.ok(!maskTokens(text).includes("secret"));
});
const OTHER: Identity = { ...ME, userId: "U0000000014", user: "hanako_s" };
const ok = (identity: Identity): IdentityOutcome => ({ kind: "ok", identity });
const failed = (kind: IdentityFailureKind): IdentityOutcome => ({
  kind: "failed",
  failure: { kind, title: FAILURE_TITLES[kind], message: "直し方" },
});
const FAILURE_KINDS: IdentityFailureKind[] = ["missing-token", "failed"];

test("前回の結果があるとき：auth.test を確かめている間は、取得しない。表示は前回の人。取得・書き込みに使う人は無い", () => {
  assert.deepEqual(decideFetch(ME, undefined), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
  });
});

test("前回の結果があるとき：auth.test が成功したら、取得してよい。表示も取得も今回の人。前回と同じ人なら、同じ名前空間のまま", () => {
  const decision = decideFetch(ME, ok(ME));
  assert.deepEqual(decision, {
    canFetch: true,
    display: ME,
    fetchAs: ME,
  });
  assert.equal(
    cacheNamespace("directory", decision.fetchAs ?? OTHER),
    cacheNamespace("directory", ME),
  );
});

test("前回の結果があるとき：今回の結果が違う人なら、表示も取得も、その人の名前空間に切り替わる（前回の人の名前空間で取得しない）", () => {
  const decision = decideFetch(ME, ok(OTHER));
  assert.equal(decision.canFetch, true);
  assert.deepEqual(decision.display, OTHER);
  assert.deepEqual(decision.fetchAs, OTHER);
  for (const kind of ["directory", "messages"] as const) {
    assert.notEqual(
      cacheNamespace(kind, decision.fetchAs ?? ME),
      cacheNamespace(kind, ME),
      `${kind} が前回の人の名前空間のまま`,
    );
  }
});

test("前回の結果があるとき：auth.test が取れなかったら（どの理由でも）、取得しない。表示は前回の人のまま。取得・書き込みに使う人は無い", () => {
  for (const kind of FAILURE_KINDS) {
    assert.deepEqual(
      decideFetch(ME, failed(kind)),
      { canFetch: false, display: ME, fetchAs: undefined },
      kind,
    );
  }
});

test("前回の結果が無いとき：確かめている間は、表示する人も取得する人も無い。成功してから、その人で取得を始める", () => {
  assert.deepEqual(decideFetch(undefined, undefined), {
    canFetch: false,
    display: undefined,
    fetchAs: undefined,
  });
  assert.deepEqual(decideFetch(undefined, ok(ME)), {
    canFetch: true,
    display: ME,
    fetchAs: ME,
  });
});

test("前回の結果が無いとき：auth.test が取れなかったら、表示する人は無いまま。取得はしない", () => {
  for (const kind of FAILURE_KINDS) {
    assert.deepEqual(
      decideFetch(undefined, failed(kind)),
      { canFetch: false, display: undefined, fetchAs: undefined },
      kind,
    );
  }
});

test("取得してよい（canFetch）のは、今回の auth.test が成功したときだけ。取得と書き込みに使う人は、今回の結果の人で、前回の結果の人ではない", () => {
  const outcomes: (IdentityOutcome | undefined)[] = [
    undefined,
    ...FAILURE_KINDS.map(failed),
    ok(ME),
    ok(OTHER),
  ];
  for (const previous of [undefined, ME, OTHER]) {
    for (const outcome of outcomes) {
      const decision = decideFetch(previous, outcome);
      const label = `${previous?.userId ?? "前回なし"} / ${outcome?.kind ?? "確かめ中"}`;
      assert.equal(decision.canFetch, outcome?.kind === "ok", label);
      // 取得してよいことと、取得・書き込みに使う人が決まっていることは、必ず同じ
      assert.equal(decision.canFetch, decision.fetchAs !== undefined, label);
      assert.deepEqual(
        decision.fetchAs,
        outcome?.kind === "ok" ? outcome.identity : undefined,
        label,
      );
      // 表示する人：成功したら今回の人、それ以外は前回の人
      assert.deepEqual(
        decision.display,
        outcome?.kind === "ok" ? outcome.identity : previous,
        label,
      );
    }
  }
});

test("sessionOf：表示する人がいれば、画面とフックに渡す形にする。取得してよいかと、取得する人は、判断のまま変えない", () => {
  assert.deepEqual(sessionOf(decideFetch(ME, ok(OTHER)), api), {
    canFetch: true,
    display: OTHER,
    fetchAs: OTHER,
    api,
  });
  // 確かめ中・失敗：前回の人の一覧は出すが、取得する人は無い
  assert.deepEqual(sessionOf(decideFetch(ME, undefined), api), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
    api,
  });
  assert.deepEqual(sessionOf(decideFetch(ME, failed("failed")), api), {
    canFetch: false,
    display: ME,
    fetchAs: undefined,
    api,
  });
});

test("sessionOf：出す一覧が無い（前回の結果が無く、今回も成功していない）ときは、何も渡さない。取得できる形にもならない", () => {
  assert.equal(sessionOf(decideFetch(undefined, undefined), api), undefined);
  for (const kind of FAILURE_KINDS) {
    assert.equal(
      sessionOf(decideFetch(undefined, failed(kind)), api),
      undefined,
    );
  }
  // 取得できる形（canFetch）になるのは、成功のときだけ
  for (const previous of [undefined, ME]) {
    for (const outcome of [undefined, ...FAILURE_KINDS.map(failed)]) {
      assert.notEqual(
        sessionOf(decideFetch(previous, outcome), api)?.canFetch,
        true,
      );
    }
  }
});

test("identityView：判断に、理由と確かめ中かを添える。確かめ中は理由が無く、失敗は確かめ中でなく理由がある", () => {
  assert.deepEqual(identityView(ME, undefined), {
    decision: decideFetch(ME, undefined),
    failure: undefined,
    checking: true,
  });
  assert.deepEqual(identityView(undefined, ok(ME)), {
    decision: decideFetch(undefined, ok(ME)),
    failure: undefined,
    checking: false,
  });
  for (const kind of FAILURE_KINDS) {
    const view = identityView(ME, failed(kind));
    assert.deepEqual(view.decision, decideFetch(ME, failed(kind)), kind);
    assert.equal(view.failure?.kind, kind);
    assert.equal(view.failure?.title, FAILURE_TITLES[kind]);
    assert.equal(view.checking, false);
  }
});
