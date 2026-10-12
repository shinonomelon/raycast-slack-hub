import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMatch } from "../../slack/hits.ts";
import { parseTriageEntry } from "../triage/triage.ts";
import { messageDetailBody } from "./message-detail.ts";

const names = { user: () => "本人", channel: () => "会話" };

test("通常検索の長文は詳細でも末尾と300文字以降のメンションを表示する", () => {
  const body = `${"あ".repeat(400)} <@U1> 本文の末尾`;
  const hit = normalizeMatch(
    { ts: "1.000001", channel: { id: "C1" }, text: body },
    "U1",
  );
  assert.ok(hit);
  assert.equal(hit.mentionsSelf, true);
  assert.equal(
    messageDetailBody(hit, names),
    `${"あ".repeat(400)} @本人 本文の末尾`,
  );
});

test("切れた旧キャッシュだけに短いプレビュー表示を付け、別途取得した全文を優先する", () => {
  const hit = normalizeMatch(
    { ts: "1.000001", channel: { id: "C1" }, text: "短い本文" },
    "U1",
  );
  assert.ok(hit);
  const short = parseTriageEntry({ at: 1, hits: [hit] })?.hits[0];
  assert.ok(short);
  assert.equal(messageDetailBody(short, names), "短い本文");
  const text = `${"あ".repeat(300)}…`;
  const preview = parseTriageEntry({ at: 1, hits: [{ ...hit, text }] })
    ?.hits[0];
  assert.ok(preview);
  assert.equal(
    messageDetailBody(preview, names),
    `プレビュー（⌘Rで全文を取得）\n\n${text}`,
  );
  assert.equal(
    messageDetailBody(preview, names, "取得した全文"),
    "取得した全文",
  );
});

// 取得済みデータを使う描画だけを検証し、Slackへ投稿しない。
test("投稿ブロックは選択した本文を先頭にし、過去を降順で並べ、未来・重複を除く", async () => {
  const { messageDetailMarkdown } = await import("./message-detail.ts");
  const { buildNames } = await import("../../slack/names.ts");
  const selected = normalizeMatch(
    {
      ts: "3.000000",
      channel: { id: "C1", name: "dev" },
      user: "U1",
      text: "selected body",
    },
    "SELF",
  )!;
  const rows = [1, 2, 3, 4].map((n) => ({
    ...selected,
    ts: `${n}.000000`,
    text: `body-${n}`,
  }));
  const rendered = messageDetailMarkdown(
    selected,
    buildNames([], [], []),
    undefined,
    {
      data: {
        messages: rows,
        rootTs: "1.000000",
        isThread: true,
        pages: 1,
        seen: [],
        capped: false,
      },
      loading: false,
      more: () => {},
      refresh: () => {},
    },
  );
  assert.equal(rendered.split("body-3").length - 1, 1);
  assert.ok(rendered.indexOf("body-3") < rendered.indexOf("body-2"));
  assert.ok(rendered.indexOf("body-2") < rendered.indexOf("body-1"));
  assert.ok(!rendered.includes("body-4"));
  assert.ok(rendered.includes("選択したメッセージ"));
  assert.ok(rendered.includes("スレッドの親投稿"));
  assert.equal(rendered.split("dev").length - 1, 1);
});

test("名前のMarkdown記号をエスケープし、本文やメンションは元の書式を残す", async () => {
  const { messageDetailMarkdown } = await import("./message-detail.ts");
  const { buildNames } = await import("../../slack/names.ts");
  const selected = normalizeMatch(
    {
      ts: "3.000000",
      channel: { id: "C1", name: "dev" },
      text: "*本文の太字*",
    },
    "SELF",
  )!;
  const lookup = {
    ...buildNames([], [], []),
    sender: () => "*[name](https://example.test)\nline",
  };
  const rendered = messageDetailMarkdown(selected, lookup);
  assert.ok(rendered.includes("\\*\\[name\\]"));
  assert.ok(rendered.includes("**本文の太字**"));
});

test("日時は日本語で曜日を含め、言語切り替えと異なる年を反映する", async () => {
  const { messageTime } = await import("./message-detail.ts");
  const { setLanguage } = await import("../../shared/i18n.ts");
  const date = new Date(2026, 9, 9, 13, 21);
  const value = String(date.getTime() / 1000);
  const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(
    date,
  );
  try {
    setLanguage("ja");
    assert.equal(messageTime(value, date), `10月9日（${weekday}）13:21`);
    assert.equal(
      messageTime(value, new Date(2027, 0, 1)),
      `2026年10月9日（${weekday}）13:21`,
    );
    setLanguage("en");
    assert.ok(messageTime(value, date).includes("Oct"));
    assert.ok(!/[ぁ-んァ-ヶ一-龠]/.test(messageTime(value, date)));
  } finally {
    setLanguage("ja");
  }
});

test("親投稿と単発投稿は本文を一度だけ表示し、親の目印を取得情報から決める", async () => {
  const { messageDetailMarkdown } = await import("./message-detail.ts");
  const { buildNames } = await import("../../slack/names.ts");
  const selected = normalizeMatch(
    { ts: "1.000000", channel: { id: "C1" }, text: "only-body" },
    "SELF",
  )!;
  for (const isThread of [false, true]) {
    const value = messageDetailMarkdown(
      selected,
      buildNames([], [], []),
      undefined,
      {
        data: {
          messages: [selected],
          rootTs: selected.ts,
          isThread,
          pages: 1,
          seen: [],
          capped: false,
        },
        loading: false,
        more: () => {},
        refresh: () => {},
      },
    );
    assert.equal(value.split("only-body").length - 1, 1);
    assert.equal(value.includes("スレッドの親投稿"), isThread);
  }
});

test("失敗・取得途中・上限の文言を両言語で表示し、選択本文を残す", async () => {
  const { messageDetailMarkdown } = await import("./message-detail.ts");
  const { buildNames } = await import("../../slack/names.ts");
  const { setLanguage } = await import("../../shared/i18n.ts");
  const selected = normalizeMatch(
    { ts: "1.000000", channel: { id: "C1" }, text: "unchanged-body" },
    "SELF",
  )!;
  try {
    for (const language of ["ja", "en"]) {
      setLanguage(language);
      for (const kind of [
        "scope",
        "rate",
        "missing",
        "invalid",
        "failed",
      ] as const) {
        const value = messageDetailMarkdown(
          selected,
          buildNames([], [], []),
          undefined,
          {
            failure: { kind, retryAt: Date.now() + 1000 },
            loading: false,
            more: () => {},
            refresh: () => {},
          },
        );
        assert.ok(value.includes("unchanged-body"));
        if (language === "en") assert.ok(!/[ぁ-んァ-ヶ一-龠]/.test(value));
      }
      for (const capped of [true, false]) {
        const value = messageDetailMarkdown(
          selected,
          buildNames([], [], []),
          undefined,
          {
            data: {
              messages: [],
              rootTs: selected.ts,
              isThread: false,
              pages: 1,
              cursor: capped ? undefined : "next",
              seen: [],
              capped,
            },
            loading: false,
            more: () => {},
            refresh: () => {},
          },
        );
        assert.ok(value.includes("unchanged-body"));
        assert.ok(
          value.includes(
            language === "en"
              ? capped
                ? "Fetch limit reached"
                : "More messages remain"
              : capped
                ? "取得上限"
                : "取得途中",
          ),
        );
      }
    }
  } finally {
    setLanguage("ja");
  }
});
