// 設定ファイル（Hub の prefs.json）の読み込みと保存。
// @raycast/api を読み込まないので、node のテストから、一時フォルダを置き場にして動かせる（prefs.ts が Raycast の置き場を渡す）
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  emptyPrefs,
  resolveInitialPrefs,
  type LegacyReaders,
} from "./prefs-merge.ts";
import type { Prefs } from "./types.ts";

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as NodeJS.ErrnoException).code === code;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// 無い・壊れているときは undefined を返す（引き継ぎ元は、その分を引き継がない）
function readJsonOrUndefined(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export type PrefsStore = {
  load: () => Prefs;
  save: (prefs: Prefs) => void;
};

// 本人に知らせる出来事。console.warn だけでは本人に見えないので、prefs.ts がトーストに直して出す。
// 画面を読み込まずにテストできるよう、お知らせの中身とトーストの文はここに置く
export type PrefsNotice =
  // 無い以外の理由で読めなかった。中身が分からないので、この回は空の設定で動き、保存しない
  | { kind: "unreadable"; reason: string }
  // 壊れていたので、別名に退避して空の設定で始めた。backup は退避先のパス
  | { kind: "broken-restarted"; backup: string }
  // 壊れていて、退避もできなかった。この回は空の設定で動き、保存しない
  | { kind: "broken-kept"; reason: string };

export type PrefsToast = {
  // 同じお知らせかを見分ける印
  key: string;
  title: string;
  message: string;
};

export function prefsNoticeToast(notice: PrefsNotice): PrefsToast {
  switch (notice.kind) {
    case "unreadable":
      return {
        key: `unreadable:${notice.reason}`,
        title: "設定ファイルを読めませんでした",
        message: `この回は空の設定で動き、変更は保存しません（${notice.reason}）`,
      };
    case "broken-restarted":
      // トーストは短くするので、退避先はファイル名だけ出す（置き場は拡張の保存フォルダ）
      return {
        key: `broken-restarted:${notice.backup}`,
        title: "設定ファイルが壊れていました",
        message: `${basename(notice.backup)} に退避して、空の設定で始めました`,
      };
    case "broken-kept":
      return {
        key: `broken-kept:${notice.reason}`,
        title: "設定ファイルが壊れています",
        message: `退避できなかったので、この回は空の設定で動き、変更は保存しません（${notice.reason}）`,
      };
  }
}

// 同じお知らせは1回だけ出す。load は画面の描画の中（useState の初期値）で呼ばれ、
// 開発中は画面を開く処理が2回走るので、同じお知らせを出し直さない。違うお知らせは、それぞれ1回出す
export function createNoticeOnce(
  show: (toast: PrefsToast) => void,
): (notice: PrefsNotice) => void {
  const shown = new Set<string>();
  return (notice) => {
    const toast = prefsNoticeToast(notice);
    if (shown.has(toast.key)) return;
    shown.add(toast.key);
    show(toast);
  };
}

// 開いた直後に並びを確定させたいので、同期で読み書きする。
// Cache は容量を超えると古いものから消えるので、消えては困る設定はファイルに置く。
// supportPath は、この拡張の保存場所（Raycast の environment.supportPath）
export function createPrefsStore(
  supportPath: string,
  options: {
    // 壊れていた・読めなかったときの記録の出し先
    warn?: (message: string) => void;
    // 同じ出来事を、本人に知らせるための受け取り先（prefs.ts がトーストにする）
    notify?: (notice: PrefsNotice) => void;
    now?: () => number;
  } = {},
): PrefsStore {
  const { warn = console.warn, notify, now = Date.now } = options;
  const path = join(supportPath, "prefs.json");

  // 引き継ぎ元は、同じ Raycast の extensions フォルダに並ぶほかの拡張の保存場所にある。
  // ここから読むだけで、書き換えも改名もしない
  const legacyFile = (extension: string, name: string) =>
    join(dirname(supportPath), extension, name);
  const legacy: LegacyReaders = {
    openChannel: () =>
      readJsonOrUndefined(legacyFile("slack-open-channel", "prefs.json")),
    quickCompose: () =>
      readJsonOrUndefined(legacyFile("slack-mention", "entries.json")),
  };

  // いまの prefs.json を上書きすると、中身を失うか、もう取り戻せなくなる状態か。
  // 読めなかったときと、壊れていて退避できなかったときに立て、その回は保存しない。
  // 次に load したとき、状態を見直す
  let keepFile = false;

  // 書きかけで止まっても元のファイルが壊れないよう、一時ファイルに書いてから置き換える。
  // 2回走る処理が同じ一時ファイルを取り合わないよう、一時ファイルの名前は毎回変える
  function save(prefs: Prefs): void {
    if (keepFile) return;
    mkdirSync(supportPath, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(prefs, null, 2));
    renameSync(temporary, path);
  }

  // 開いたときに呼ばれる。画面を開く処理が2回走っても困らないよう、初回の引き継ぎも、壊れたファイルの退避も、
  // 同期で行い、すぐ保存する。1回目が書いたファイルを2回目が読めば、2回目は何もしない
  function load(): Prefs {
    keepFile = false;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        // 無い（初回）。引き継ぎ元を読んで合成し、すぐ保存する。次からは Hub の prefs.json だけを使い、引き継ぎ元は読まない
        const { prefs } = resolveInitialPrefs(undefined, legacy);
        save(prefs);
        return prefs;
      }
      // 権限など、無い以外の理由で読めない。中身が分からないので、退避も引き継ぎもせず、
      // この回は空の設定で動く。そのファイルは上書きしない
      keepFile = true;
      warn(
        `prefs.json を読めませんでした（${reason(error)}）。この回は空の設定で動き、保存しません`,
      );
      notify?.({ kind: "unreadable", reason: reason(error) });
      return emptyPrefs();
    }

    let hub: unknown;
    try {
      hub = JSON.parse(text);
    } catch {
      return startOverFromBrokenFile();
    }
    // Hub の prefs.json があるので、それだけを使う。引き継ぎ元は読まない
    return resolveInitialPrefs(hub, legacy).prefs;
  }

  // JSON として読めない。次の保存で上書きして失わないよう、別名に退避して、空の設定で始める。
  // 引き継ぎは初回だけなので、引き継ぎ元は読まない。すぐ空の設定を保存するのは、
  // 保存しないと、次に開いたときに「無い」ものとして引き継ぎ元を読んでしまうため
  function startOverFromBrokenFile(): Prefs {
    const backup = `${path}.broken-${now()}`;
    try {
      renameSync(path, backup);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        // 退避できなかったので、上書きすると、壊れた中身（直せば読めるかもしれない）が残らない
        keepFile = true;
        warn(
          `prefs.json が壊れていますが、退避できませんでした（${reason(error)}）。この回は空の設定で動き、保存しません`,
        );
        notify?.({ kind: "broken-kept", reason: reason(error) });
        return emptyPrefs();
      }
      // 2回走る処理のもう一方が先に退避した。続ける
    }
    const prefs = emptyPrefs();
    save(prefs);
    warn(
      `prefs.json が壊れていたので、${backup} に退避して、空の設定で始めました`,
    );
    notify?.({ kind: "broken-restarted", backup });
    return prefs;
  }

  return { load, save };
}
