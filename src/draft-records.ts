// Hub が作った下書きの控え（drafts.json）の読み書き（2026年10月8日）。
// Slack 側の下書きは、MCP にも公開 API にも読む・消す手段が無いので、Hub が作ったものだけを手元に控えて一覧に出す。
// 控えは Slack 側と同期しない（Slack で送った・消した下書きも、30日たつか手で消すまで残る）。
// @raycast/api を読み込まないので、node のテストから、一時フォルダを置き場にして動かせる
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slackAppMessageLink, targetLink, type SendTarget } from "./compose.ts";
import type { Identity } from "./identity.ts";

export const DRAFT_RECORDS_FILE = "drafts.json";

// 作ってからこれより古い控えは、読み込むときに消す
export const DRAFT_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;

export type DraftRecord = {
  // Slack が返した下書きの ID（Dr…）
  draftId: string;
  // 作ったワークスペースと人。別のワークスペース・別の人の控えは一覧に出さない
  teamId: string;
  userId: string;
  // 宛先（会話か人）と、その表示（#名前・@名前）
  target: SendTarget;
  destination: string;
  // スレッドへの返信の下書きのとき、スレッドの親の ts
  threadTs?: string;
  // Slack に渡した本文（メンションを含む）
  markdown: string;
  // 作った時刻（ISO 8601）
  createdAt: string;
};

type Who = Pick<Identity, "teamId" | "userId">;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

function readTarget(value: unknown): SendTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, id } = value as Record<string, unknown>;
  if ((kind !== "conversation" && kind !== "person") || !isText(id)) {
    return undefined;
  }
  return { kind, id };
}

// 1件の控えを読む。項目が欠けている・形が違うものは、壊れた控えとして undefined
export function readRecord(value: unknown): DraftRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const target = readTarget(v.target);
  if (
    !isText(v.draftId) ||
    !isText(v.teamId) ||
    !isText(v.userId) ||
    !target ||
    !isText(v.destination) ||
    typeof v.markdown !== "string" ||
    !isText(v.createdAt) ||
    Number.isNaN(Date.parse(v.createdAt))
  ) {
    return undefined;
  }
  if (v.threadTs !== undefined && !isText(v.threadTs)) return undefined;
  return {
    draftId: v.draftId,
    teamId: v.teamId,
    userId: v.userId,
    target,
    destination: v.destination,
    ...(v.threadTs !== undefined ? { threadTs: v.threadTs as string } : {}),
    markdown: v.markdown,
    createdAt: v.createdAt,
  };
}

// ファイルの中身（配列）から、読める控えだけを返す。配列でなければ undefined（ファイルが壊れている）
export function parseRecords(value: unknown): DraftRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const record = readRecord(item);
    return record ? [record] : [];
  });
}

export const isExpired = (record: DraftRecord, now: number): boolean =>
  now - Date.parse(record.createdAt) > DRAFT_RECORD_TTL_MS;

// 期限を過ぎた控えを除く。別のワークスペース・別の人の控えも、期限内なら残す
export const pruneExpired = (
  records: readonly DraftRecord[],
  now: number,
): DraftRecord[] => records.filter((record) => !isExpired(record, now));

const isMine = (record: DraftRecord, who: Who) =>
  record.teamId === who.teamId && record.userId === who.userId;

// 一覧に出す控え。今のワークスペースと自分の、期限内のものを、新しい順に
export function recordsFor(
  records: readonly DraftRecord[],
  who: Who,
  now: number,
): DraftRecord[] {
  return records
    .filter((record) => isMine(record, who) && !isExpired(record, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// 控えを足す。同じ draft_id の控えがあれば置き換える
export const addRecord = (
  records: readonly DraftRecord[],
  record: DraftRecord,
): DraftRecord[] => [
  ...records.filter((r) => r.draftId !== record.draftId),
  record,
];

// 自分の控えを1件消す
export const removeRecord = (
  records: readonly DraftRecord[],
  draftId: string,
  who: Who,
): DraftRecord[] =>
  records.filter((r) => !(r.draftId === draftId && isMine(r, who)));

// ---- 表示 ------------------------------------------------------------------------

// メンションだけの行（<@U…> を空白で並べたもの）
const MENTION_ONLY = /^(?:<@[A-Z0-9]+>\s*)+$/;

// 一覧の行の題。本文の最初の行（空行とメンションだけの行を除く）
export function recordTitle(record: Pick<DraftRecord, "markdown">): string {
  const line = record.markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !MENTION_ONLY.test(l));
  return line ?? "（本文なし）";
}

// 本文のメンション（<@U…>）を、表示用に @名前 へ直す。名前が分からない人は @U… のまま出す
export function withMentionNames(
  markdown: string,
  names: ReadonlyMap<string, string>,
): string {
  return markdown.replace(
    /<@([A-Z0-9]+)>/g,
    (_, id: string) => `@${names.get(id) ?? id}`,
  );
}

// 一覧の行の宛先。スレッドへの返信なら「のスレッド」を付ける
export const recordDestination = (
  record: Pick<DraftRecord, "destination" | "threadTs">,
): string =>
  record.threadTs ? `${record.destination} のスレッド` : record.destination;

// Slack で開く先。スレッドへの返信の下書きはスレッドの親の投稿、それ以外は宛先の会話（人なら DM）。
// 親の位置は、送れたか未確認のときに開く先（compose.ts の confirmationOf）と同じ形のリンクにする
export function recordLink(
  record: Pick<DraftRecord, "teamId" | "target" | "threadTs">,
): string {
  if (record.threadTs && record.target.kind === "conversation") {
    return slackAppMessageLink(
      record.teamId,
      record.target.id,
      record.threadTs,
    );
  }
  return targetLink(record.teamId, record.target);
}

// ---- ファイル --------------------------------------------------------------------

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as NodeJS.ErrnoException).code === code;

export type DraftStore = {
  // 自分の控えを新しい順に返す。期限切れと壊れた控えを除いてファイルに書き戻す
  load: (who: Who) => DraftRecord[];
  add: (record: DraftRecord) => void;
  remove: (draftId: string, who: Who) => void;
};

// 控えは、フォーム（Slack Hub）と一覧（Slack Drafts）の2つのコマンドから書かれる。
// 取り違えないよう、操作のたびにファイルを読み直し、直して、一時ファイルに書いてから置き換える。
// 無い以外の理由で読めないときは投げる（呼び出し側がトーストで知らせる）。上書きしないので中身は失わない。
// JSON として読めない・配列でないときは、別名に退避して空から始める（prefs-store.ts と同じ扱い）
export function createDraftStore(
  supportPath: string,
  options: { now?: () => number; warn?: (message: string) => void } = {},
): DraftStore {
  const { now = Date.now, warn = console.warn } = options;
  const path = join(supportPath, DRAFT_RECORDS_FILE);

  function write(records: readonly DraftRecord[]): void {
    mkdirSync(supportPath, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(records, null, 2));
    renameSync(temporary, path);
  }

  // 読めた控えと、ファイルの項目数（壊れた控えを捨てたかを見るため）
  function read(): { records: DraftRecord[]; count: number } {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { records: [], count: 0 };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const records = parseRecords(value);
    if (records) {
      const count = (value as unknown[]).length;
      // 読めない控えは次の書き込みで消える。形の変わった版から戻したときなどに、
      // 別の人の分も含めて取り戻せるよう、書き戻す前に元のファイルを別名に写しておく
      if (records.length < count) {
        const backup = `${path}.broken-${now()}`;
        writeFileSync(backup, text);
        warn(
          `${DRAFT_RECORDS_FILE} に読めない控えがあったので、元のファイルを ${backup} に写しました`,
        );
      }
      return { records, count };
    }
    // 壊れている。次の書き込みで失わないよう、別名に退避する
    const backup = `${path}.broken-${now()}`;
    try {
      renameSync(path, backup);
      warn(`${DRAFT_RECORDS_FILE} が壊れていたので、${backup} に退避しました`);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      // もう一方のコマンドが先に退避した
    }
    return { records: [], count: 0 };
  }

  function load(who: Who): DraftRecord[] {
    const { records, count } = read();
    const kept = pruneExpired(records, now());
    if (kept.length !== count) write(kept);
    return recordsFor(kept, who, now());
  }

  function add(record: DraftRecord): void {
    write(addRecord(pruneExpired(read().records, now()), record));
  }

  function remove(draftId: string, who: Who): void {
    write(removeRecord(pruneExpired(read().records, now()), draftId, who));
  }

  return { load, add, remove };
}
