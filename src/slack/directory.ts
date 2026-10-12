import { join } from "node:path";
import { refreshIntervalMs, readSettings } from "../shared/settings.ts";
import { DirectoryRefreshStore } from "./directory-refresh-store.ts";
import { scanDirectory } from "./directory-pages.ts";
import { acquireFileLease } from "./file-lease.ts";
import { getApiCredentialKey, apiWithSource } from "./request-context.ts";
import { t } from "../shared/i18n.ts";
import { Cache, environment, showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { cacheNamespace, type Identity, type Session } from "./identity.ts";
import { createSingleFlight } from "../shared/single-flight.ts";
import type { ApiCall } from "./slack-api.ts";
import {
  listConversations,
  listJoinedChannelIds,
  listPeople,
  normalizeConversations,
  normalizePeople,
  normalizeJoined,
} from "./slack.ts";
import type { Conversation, Person } from "../shared/types.ts";
// 同じ拡張のコマンド間で共有される、ディスク上のキャッシュ。
// 名前空間を分けないと、@raycast/utils（useFrecencySorting）が同じフォルダに作る別の Cache と
// 索引（journal）を互いに上書きし、一覧が保存されていないことになる（2026年10月4日に起動のたびの取り直しで発覚）。
// さらに、ワークスペースと自分の ID ごとに分ける（identity.ts の cacheNamespace）。
// トークンやトークン設定を替えても、別の人の一覧が混ざらない。
// 自分の情報が決まる前の名前空間（directory）は、読まない・消さない
const caches = new Map<string, Cache>();
function cacheOf(identity: Identity): Cache {
  const namespace = cacheNamespace("directory", identity);
  let cache = caches.get(namespace);
  if (!cache) {
    cache = new Cache({ namespace });
    caches.set(namespace, cache);
  }
  return cache;
}
const HOUR = 60 * 60 * 1000;
export type Directory<T> = {
  key: string;
  label: string;
  // Slack APIを呼ぶ関数（api）を受けて、一覧を取る
  fetcher: (api: ApiCall) => Promise<T>;
  maxAgeMs: number;
};
// チャンネルは作られる頻度が高いので1時間、人は入退社くらいしか変わらないので1日で取り直す
export const CONVERSATIONS: Directory<Conversation[]> = {
  key: "conversations",
  get label() {
    return t("チャンネル");
  },
  fetcher: listConversations,
  get maxAgeMs() {
    return refreshIntervalMs(readSettings().backgroundRefreshFrequency);
  },
};
export const PEOPLE: Directory<Person[]> = {
  key: "people",
  get label() {
    return t("メンバー");
  },
  fetcher: listPeople,
  maxAgeMs: 24 * HOUR,
};
// 自分が参加している公開チャンネル。参加・退出は頻繁なので1時間で取り直す
export const JOINED: Directory<string[]> = {
  key: "joined",
  get label() {
    return t("参加中のチャンネル");
  },
  fetcher: listJoinedChannelIds,
  get maxAgeMs() {
    return refreshIntervalMs(readSettings().backgroundRefreshFrequency);
  },
};
type Entry<T> = {
  fetchedAt: number;
  data: T;
};
function read<T>(identity: Identity, key: string): Entry<T> | undefined {
  const raw = cacheOf(identity).get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Entry<T>;
  } catch {
    return undefined;
  }
}
// 同じ一覧の取得は、画面が重なっても1つだけ動かす。人の取得は25秒ほどかかり、その間に一覧から開いた
// フォームが、同じ取得を重ねて始めないようにする（実行中の取得を待ち、終わったら同じ結果を受け取る）。
// 人（名前空間）が違う取得は、別のものとして動かす
const singleFlight = createSingleFlight();
export const directoryStore = () =>
  new DirectoryRefreshStore(join(environment.supportPath, "directory-refresh"));
export type DirectoryResult<T> =
  | { kind: "complete"; entry: Entry<T> }
  | { kind: "pending"; retryAt?: number }
  | { kind: "busy" };
function fetchAndStore<T>(
  dir: Directory<T>,
  identity: Identity,
  api: ApiCall,
): Promise<DirectoryResult<T>> {
  const credentialKey = getApiCredentialKey(api);
  return singleFlight(
    `${credentialKey ?? "untracked"}/${cacheNamespace("directory", identity)}/${dir.key}`,
    async () => {
      if (!credentialKey)
        throw new Error("Directory API credential metadata is missing");
      const store = directoryStore();
      const scheduleKey = `schedule-${credentialKey}`;
      const scheduleLease = acquireFileLease(
        `${store.path(scheduleKey)}.lock`,
        15000,
      );
      if (scheduleLease) {
        try {
          scheduleLease.runIfOwner(() =>
            store.write(scheduleKey, { lastStartedAt: Date.now(), identity }),
          );
        } finally {
          scheduleLease.release();
        }
      }
      const specs = {
        conversations: {
          method: "conversations.list",
          field: "channels",
          params: {
            types: "public_channel,private_channel,mpim",
            exclude_archived: true,
          },
          normalize: normalizeConversations,
        },
        people: {
          method: "users.list",
          field: "members",
          params: {},
          normalize: normalizePeople,
        },
        joined: {
          method: "users.conversations",
          field: "channels",
          params: { types: "public_channel", exclude_archived: true },
          normalize: normalizeJoined,
        },
      } as const;
      const spec = specs[dir.key as keyof typeof specs];
      const result = spec
        ? await scanDirectory({
            api,
            credentialKey,
            kind: dir.key,
            store,
            ...spec,
          })
        : { kind: "complete" as const, rows: await dir.fetcher(api) };
      if (result.kind !== "complete") return result;
      const entry = {
        fetchedAt: Date.now(),
        data: (spec
          ? spec.normalize(result.rows as unknown[])
          : result.rows) as T,
      };
      const lease = await acquireFileLease(
        `${store.path(`publish-${cacheNamespace("directory", identity)}`)}.lock`,
        15000,
      );
      if (!lease) return { kind: "busy" };
      try {
        const published = lease.runIfOwner(() => {
          // 別プロセスの更新した索引を読み直してから公開する。
          const namespace = cacheNamespace("directory", identity);
          const cache = new Cache({ namespace });
          cache.set(dir.key, JSON.stringify(entry));
          caches.set(namespace, cache);
          if ("checkpointKey" in result) store.remove(result.checkpointKey);
          return true;
        });
        if (!published) return { kind: "busy" };
        return { kind: "complete", entry };
      } finally {
        await lease.release();
      }
    },
  );
}
export function directoryHasCache(
  dir: Directory<unknown>,
  identity: Identity,
): boolean {
  const entry = read(identity, dir.key);
  return (
    !!entry && Array.isArray(entry.data) && Number.isFinite(entry.fetchedAt)
  );
}
export function directoryIsFresh(
  dir: Directory<unknown>,
  identity: Identity,
  now = Date.now(),
): boolean {
  const entry = read(identity, dir.key);
  return (
    !!entry &&
    Array.isArray(entry.data) &&
    Number.isFinite(entry.fetchedAt) &&
    entry.fetchedAt <= now &&
    now - entry.fetchedAt <= dir.maxAgeMs
  );
}
// 古くなっていたときだけ取り直す。裏で定期的に動くコマンドから呼ぶ。
// 呼ぶ側が、今回の auth.test で取れた自分の情報（identity）を渡す。取れる前に呼ばない
export async function refreshIfStale<T>(
  dir: Directory<T>,
  identity: Identity,
  api: ApiCall,
): Promise<boolean> {
  const entry = read<T>(identity, dir.key);
  if (entry && directoryIsFresh(dir, identity)) return false;
  return (await fetchAndStore(dir, identity, api)).kind === "complete";
}
// 前回の一覧をディスクから即座に返す。取り直しは裏のコマンド（refresh-directory）に任せ、
// 画面からはキャッシュが空のときだけ取る。人の取得は25秒ほどかかり、
// 取得中に閉じるとプロセスごと止まって結果を捨てることになるため。
// 保存した一覧は、前回の結果の人（session.display）のものでも出す。Slack から取って保存するのは、
// 今回の auth.test が成功したとき（session.canFetch）の、その人（session.fetchAs）の名前空間にだけ。
// 前回と同じトークン設定のトークンが別のワークスペースのものに替わっていても、混ざらないようにするため
export function useDirectory<T>(dir: Directory<T>, session: Session) {
  const [entry, setEntry] = useState(() => read<T>(session.display, dir.key));
  const [isLoading, setIsLoading] = useState(false);
  const [wait, setWait] = useState<
    import("./directory-state.ts").DirectoryWait
  >({ status: "idle" });
  // この画面で全ページを取得したことを示す。古いキャッシュだけでは移行を確定しない。
  const [fresh, setFresh] = useState(false);
  // 取得中に再読み込みを押されても Slack API を重ねて動かさず、実行中の取得を待つ
  const inFlight = useRef<Promise<void>>(undefined);
  const reload = useCallback(() => {
    // 取得してよい人が決まるまで（今回の auth.test が成功するまで）、Slack から取らない
    if (!session.canFetch) return Promise.resolve();
    const { fetchAs } = session;
    if (inFlight.current) return inFlight.current;
    setIsLoading(true);
    setWait({ status: "loading" });
    setFresh(false);
    inFlight.current = (async () => {
      try {
        const result = await fetchAndStore(
          dir,
          fetchAs,
          apiWithSource(session.api, "directory"),
        );
        if (result.kind === "complete") {
          setWait({ status: "complete" });
          setEntry(result.entry);
          setFresh(true);
        } else {
          setWait({
            status: result.kind,
            ...(result.kind === "pending" ? { retryAt: result.retryAt } : {}),
          });
          await showToast({
            style: Toast.Style.Success,
            title:
              result.kind === "busy"
                ? t("一覧を取得中です")
                : t("一覧の取得を一時停止しています"),
            message: t("再読み込みで取得を続けられます"),
          });
        }
      } catch (error) {
        setWait({ status: "failed" });
        await showToast({
          style: Toast.Style.Failure,
          title: t("{0}の一覧を更新できませんでした", dir.label),
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight.current = undefined;
        setIsLoading(false);
      }
    })();
    return inFlight.current;
  }, [dir, session]);
  useEffect(() => {
    if (entry || !session.canFetch) return;
    // 開いたあとに、ほかの画面が取り終えていることがある。それならそれを使い、取り直さない
    const stored = read<T>(session.fetchAs, dir.key);
    if (stored) setEntry(stored);
    else void reload();
    // 開いたときと、今回の auth.test が成功したときに判定する
  }, [session.canFetch]);
  return { data: entry?.data, isLoading, fresh, reload, ...wait };
}
