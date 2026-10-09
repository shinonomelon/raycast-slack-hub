import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyPrefs } from "./prefs-merge.ts";
import {
  createNoticeOnce,
  createPrefsStore,
  prefsNoticeToast,
  type PrefsNotice,
  type PrefsToast,
} from "./prefs-store.ts";
import type { Prefs } from "../../shared/types.ts";

// 本物のファイルを、一時フォルダの中で読み書きして確かめる。置き場は Raycast の extensions フォルダと同じ並びにする：
//   <root>/slack-hub（Hub の保存場所）・<root>/slack-open-channel・<root>/slack-mention（引き継ぎ元）
type Env = {
  hubDir: string;
  hubFile: string;
  warnings: string[];
  // 本人に知らせる出来事（prefs.ts がトーストにする）
  notices: PrefsNotice[];
  store: ReturnType<typeof createPrefsStore>;
  // 引き継ぎ元の2つのファイルを書く。お気に入りの ID を変えて、読まれたかどうかを見分ける
  writeLegacy: (openChannelFavorite: string, composeChannel: string) => void;
};

const NOW = 1759560000000;

function withExtensions(body: (env: Env) => void): void {
  const root = mkdtempSync(join(tmpdir(), "slack-hub-prefs-"));
  const hubDir = join(root, "slack-hub");
  const warnings: string[] = [];
  const notices: PrefsNotice[] = [];
  try {
    body({
      hubDir,
      hubFile: join(hubDir, "prefs.json"),
      warnings,
      notices,
      store: createPrefsStore(hubDir, {
        warn: (message) => warnings.push(message),
        notify: (notice) => notices.push(notice),
        now: () => NOW,
      }),
      writeLegacy: (openChannelFavorite, composeChannel) => {
        mkdirSync(join(root, "slack-open-channel"), { recursive: true });
        writeFileSync(
          join(root, "slack-open-channel", "prefs.json"),
          JSON.stringify({
            favorites: [openChannelFavorite],
            aliases: {},
            dictionary: [],
            membership: "joined",
          }),
        );
        mkdirSync(join(root, "slack-mention"), { recursive: true });
        writeFileSync(
          join(root, "slack-mention", "entries.json"),
          JSON.stringify({
            targets: [],
            channels: [{ id: composeChannel, name: "#x" }],
          }),
        );
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hubPrefs = (favorite: string): Prefs => ({
  favorites: [favorite],
  aliases: {},
  dictionary: [],
  membership: "notJoined",
});

const readPrefsFile = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf8"));

test("初回はほかの拡張に設定があっても空から始め、Hubの設定だけを保存する", () => {
  withExtensions(({ hubFile, store, warnings, notices, writeLegacy }) => {
    writeLegacy("C-open-channel", "C-compose");
    // 置き場のフォルダもまだ無い状態から始める
    assert.ok(!existsSync(hubFile));

    const first = store.load();
    assert.deepEqual(first, emptyPrefs());
    assert.deepEqual(readPrefsFile(hubFile), first);

    // 引き継ぎ元が変わっても、2回目は読まない
    writeLegacy("C-changed", "C-changed-2");
    assert.deepEqual(store.load(), first);
    assert.deepEqual(warnings, []);
    // 何も起きていないので、本人に知らせることも無い
    assert.deepEqual(notices, []);
  });
});

test("Hub の prefs.json があるときは、それだけを使い、引き継ぎ元を読まず、ファイルにも触れない", () => {
  withExtensions(
    ({ hubDir, hubFile, store, warnings, notices, writeLegacy }) => {
      writeLegacy("C-open-channel", "C-compose");
      mkdirSync(hubDir, { recursive: true });
      const content = JSON.stringify(hubPrefs("C-hub"));
      writeFileSync(hubFile, content);

      assert.deepEqual(store.load(), hubPrefs("C-hub"));
      assert.equal(readFileSync(hubFile, "utf8"), content);
      assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
      assert.deepEqual(warnings, []);
      assert.deepEqual(notices, []);
    },
  );
});

test("壊れた JSON は、別名に退避して空の設定で始める。引き継ぎ元は読まず、次からは空の設定のファイルを読む", () => {
  withExtensions(
    ({ hubDir, hubFile, store, warnings, notices, writeLegacy }) => {
      writeLegacy("C-open-channel", "C-compose");
      mkdirSync(hubDir, { recursive: true });
      writeFileSync(hubFile, "{ 壊れた");

      // 引き継ぎ元に中身があっても、読まない
      assert.deepEqual(store.load(), emptyPrefs());
      const backup = `prefs.json.broken-${NOW}`;
      assert.deepEqual(readdirSync(hubDir).sort(), ["prefs.json", backup]);
      assert.equal(readFileSync(join(hubDir, backup), "utf8"), "{ 壊れた");
      assert.deepEqual(readPrefsFile(hubFile), emptyPrefs());
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(backup));
      // 本人に知らせる：壊れていたので退避したこと。退避先も渡す
      assert.deepEqual(notices, [
        { kind: "broken-restarted", backup: join(hubDir, backup) },
      ]);

      // 保存してあるので、次に開いたときは「無い」ものとして引き継ぎ元を読み直さない。退避も増えない
      writeLegacy("C-changed", "C-changed-2");
      assert.deepEqual(store.load(), emptyPrefs());
      assert.deepEqual(readdirSync(hubDir).sort(), ["prefs.json", backup]);
      assert.equal(warnings.length, 1);
      assert.equal(notices.length, 1);
    },
  );
});

test("空のファイルも壊れたものとして扱い、退避して空の設定で始める", () => {
  withExtensions(({ hubDir, hubFile, store, writeLegacy }) => {
    writeLegacy("C-open-channel", "C-compose");
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(hubFile, "");
    assert.deepEqual(store.load(), emptyPrefs());
    assert.ok(existsSync(join(hubDir, `prefs.json.broken-${NOW}`)));
  });
});

test("JSON として読めて形が違う場合は、壊れたものとして退避せず、使える項目だけを残す", () => {
  withExtensions(({ hubDir, hubFile, store, warnings, notices }) => {
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(hubFile, JSON.stringify(["配列"]));
    assert.deepEqual(store.load(), emptyPrefs());
    assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(notices, []);
  });
});

test("無い以外の理由で読めないとき（EISDIR）は、退避も引き継ぎもせず、空の設定で動き、そのファイルを上書きしない", () => {
  withExtensions(
    ({ hubDir, hubFile, store, warnings, notices, writeLegacy }) => {
      writeLegacy("C-open-channel", "C-compose");
      // prefs.json がフォルダになっていて、読むと EISDIR になる。中のファイルが残っているかで、上書きや消去を見分ける
      mkdirSync(hubFile, { recursive: true });
      writeFileSync(join(hubFile, "keep.txt"), "残す");

      assert.deepEqual(store.load(), emptyPrefs());
      assert.equal(warnings.length, 1);
      // 本人に知らせる：読めなかったので、この回は保存しないこと
      assert.equal(notices.length, 1);
      assert.equal(notices[0].kind, "unreadable");
      assert.ok(
        notices[0].kind === "unreadable" &&
          notices[0].reason.includes("EISDIR"),
      );
      // 退避も保存もされていない
      assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
      assert.ok(statSync(hubFile).isDirectory());
      assert.equal(readFileSync(join(hubFile, "keep.txt"), "utf8"), "残す");

      // この回の保存も、そのファイルを上書きしない（一時ファイルも作らない）
      store.save(hubPrefs("C-new"));
      assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
      assert.ok(statSync(hubFile).isDirectory());

      // 読めるようになった（ここでは、フォルダを片づけて「無い」状態に戻した）あとの load で、保存も戻る
      rmSync(hubFile, { recursive: true });
      assert.deepEqual(store.load(), emptyPrefs());
      store.save(hubPrefs("C-new"));
      assert.deepEqual(readPrefsFile(hubFile), hubPrefs("C-new"));
    },
  );
});

test(
  "権限が無くて読めないとき（EACCES）も、退避も引き継ぎもせず、空の設定で動き、そのファイルを上書きしない",
  {
    skip:
      process.getuid?.() === 0 &&
      "root は権限があっても読めてしまうので、確かめられない",
  },
  () => {
    withExtensions(
      ({ hubDir, hubFile, store, warnings, notices, writeLegacy }) => {
        writeLegacy("C-open-channel", "C-compose");
        mkdirSync(hubDir, { recursive: true });
        const content = JSON.stringify(hubPrefs("C-hub"));
        writeFileSync(hubFile, content);
        chmodSync(hubFile, 0o000);
        try {
          assert.throws(() => readFileSync(hubFile), { code: "EACCES" });
          assert.deepEqual(store.load(), emptyPrefs());
          assert.equal(warnings.length, 1);
          assert.equal(notices.length, 1);
          assert.equal(notices[0].kind, "unreadable");
          store.save(hubPrefs("C-new"));
        } finally {
          chmodSync(hubFile, 0o600);
        }
        // 退避も上書きもされず、中身はそのまま
        assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
        assert.equal(readFileSync(hubFile, "utf8"), content);
      },
    );
  },
);

test(
  "壊れていて、退避もできないとき（置き場に書き込めない）は、この回は空の設定で動き、保存しない",
  {
    skip:
      process.getuid?.() === 0 &&
      "root は権限があっても書けてしまうので、確かめられない",
  },
  () => {
    withExtensions(
      ({ hubDir, hubFile, store, warnings, notices, writeLegacy }) => {
        writeLegacy("C-open-channel", "C-compose");
        mkdirSync(hubDir, { recursive: true });
        writeFileSync(hubFile, "{ 壊れた");
        // 読めるが、置き場に書けない（改名も新しいファイルも作れない）
        chmodSync(hubDir, 0o500);
        try {
          assert.throws(() => writeFileSync(join(hubDir, "probe"), "x"), {
            code: "EACCES",
          });
          assert.deepEqual(store.load(), emptyPrefs());
          assert.equal(warnings.length, 1);
          // 本人に知らせる：壊れているが退避できなかったので、この回は保存しないこと
          assert.equal(notices.length, 1);
          assert.equal(notices[0].kind, "broken-kept");
        } finally {
          chmodSync(hubDir, 0o700);
        }
        // 壊れた中身が、そのまま残っている（退避も保存もされていない）
        assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
        assert.equal(readFileSync(hubFile, "utf8"), "{ 壊れた");

        // 書けるようになっても、この回（次の load まで）は保存しない
        store.save(hubPrefs("C-new"));
        assert.equal(readFileSync(hubFile, "utf8"), "{ 壊れた");
      },
    );
  },
);

test("保存した設定は、そのまま読み直せる。一時ファイルは残らず、置き場のフォルダが無ければ作る", () => {
  withExtensions(({ hubDir, hubFile, store }) => {
    assert.ok(!existsSync(hubDir));
    store.save(hubPrefs("C-1"));
    store.save(hubPrefs("C-2"));
    assert.deepEqual(readdirSync(hubDir), ["prefs.json"]);
    assert.deepEqual(readPrefsFile(hubFile), hubPrefs("C-2"));
    assert.deepEqual(store.load(), hubPrefs("C-2"));
  });
});

test("トーストの文：壊れていたときは退避先のファイル名を出し（置き場のパスは出さない）、読めなかったときは理由を出す", () => {
  const backup = `/Users/x/extensions/slack-hub/prefs.json.broken-${NOW}`;
  const broken = prefsNoticeToast({ kind: "broken-restarted", backup });
  assert.equal(broken.title, "設定ファイルが壊れていました");
  assert.ok(broken.message.includes(`prefs.json.broken-${NOW}`));
  assert.ok(!broken.message.includes("/Users/x"));

  const unreadable = prefsNoticeToast({
    kind: "unreadable",
    reason: "EACCES: permission denied",
  });
  assert.ok(unreadable.message.includes("EACCES: permission denied"));
  // 保存しないことを、本人に伝える
  assert.ok(unreadable.message.includes("保存しません"));

  // 読めなかったお知らせと同じ理由で起きても、退避できなかったお知らせは別のお知らせ（印は種類で変わる）
  const kept = prefsNoticeToast({
    kind: "broken-kept",
    reason: "EACCES: permission denied",
  });
  assert.ok(kept.message.includes("保存しません"));
  // 3つとも違う印であること。2つが同じでも通らないよう、大きさが3であることを確かめる
  assert.equal(
    new Set([broken.key, unreadable.key, kept.key]).size,
    3,
    "お知らせの種類ごとに、別の印が付く",
  );
});

test("同じお知らせは1回だけ出し、違うお知らせはそれぞれ出す（load が2回呼ばれても、トーストは重ならない）", () => {
  const shown: PrefsToast[] = [];
  const notify = createNoticeOnce((toast) => shown.push(toast));
  const broken: PrefsNotice = {
    kind: "broken-restarted",
    backup: "/x/prefs.json.broken-1",
  };

  notify(broken);
  notify(broken);
  assert.equal(shown.length, 1);

  notify({ kind: "unreadable", reason: "EACCES" });
  notify({ kind: "unreadable", reason: "EACCES" });
  assert.equal(shown.length, 2);

  // 退避先が違えば、別の壊れ方（もう一度壊れた）なので、もう一度出す
  notify({ kind: "broken-restarted", backup: "/x/prefs.json.broken-2" });
  assert.equal(shown.length, 3);
});
