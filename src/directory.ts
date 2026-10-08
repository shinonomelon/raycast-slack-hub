import { Cache, showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { cacheNamespace, type Identity, type Session } from "./identity.ts";
import { createSingleFlight } from "./single-flight.ts";
import type { Run } from "./slack-cli.ts";
import { runSlackCli } from "./slack-cli-runner.ts";
import {
  listConversations,
  listJoinedChannelIds,
  listPeople,
} from "./slack.ts";
import type { Conversation, Person } from "./types.ts";

// 同じ拡張のコマンド間で共有される、ディスク上のキャッシュ。
// 名前空間を分けないと、@raycast/utils（useFrecencySorting）が同じフォルダに作る別の Cache と
// 索引（journal）を互いに上書きし、一覧が保存されていないことになる（2026年10月4日に起動のたびの取り直しで発覚）。
// さらに、ワークスペースと自分の ID ごとに分ける（identity.ts の cacheNamespace）。
// トークンやプロファイルを替えても、別の人の一覧が混ざらない。
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
  // slack-cli を呼ぶ関数（run）を受けて、一覧を取る
  fetcher: (run: Run) => Promise<T>;
  maxAgeMs: number;
};

// チャンネルは作られる頻度が高いので1時間、人は入退社くらいしか変わらないので1日で取り直す
export const CONVERSATIONS: Directory<Conversation[]> = {
  key: "conversations",
  label: "チャンネル",
  fetcher: listConversations,
  maxAgeMs: HOUR,
};
export const PEOPLE: Directory<Person[]> = {
  key: "people",
  label: "メンバー",
  fetcher: listPeople,
  maxAgeMs: 24 * HOUR,
};

// 自分が参加している公開チャンネル。参加・退出は頻繁なので1時間で取り直す
export const JOINED: Directory<string[]> = {
  key: "joined",
  label: "参加中のチャンネル",
  fetcher: listJoinedChannelIds,
  maxAgeMs: HOUR,
};

type Entry<T> = { fetchedAt: number; data: T };

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

function fetchAndStore<T>(
  dir: Directory<T>,
  identity: Identity,
): Promise<Entry<T>> {
  return singleFlight(
    `${cacheNamespace("directory", identity)}/${dir.key}`,
    async () => {
      const entry = {
        fetchedAt: Date.now(),
        data: await dir.fetcher(runSlackCli),
      };
      cacheOf(identity).set(dir.key, JSON.stringify(entry));
      return entry;
    },
  );
}

// 古くなっていたときだけ取り直す。裏で定期的に動くコマンドから呼ぶ。
// 呼ぶ側が、今回の whoami で取れた自分の情報（identity）を渡す。取れる前に呼ばない
export async function refreshIfStale<T>(
  dir: Directory<T>,
  identity: Identity,
): Promise<boolean> {
  const entry = read<T>(identity, dir.key);
  if (entry && Date.now() - entry.fetchedAt <= dir.maxAgeMs) return false;
  await fetchAndStore(dir, identity);
  return true;
}

// 前回の一覧をディスクから即座に返す。取り直しは裏のコマンド（refresh-directory）に任せ、
// 画面からはキャッシュが空のときだけ取る。人の取得は25秒ほどかかり、
// 取得中に閉じるとプロセスごと止まって結果を捨てることになるため。
// 保存した一覧は、前回の結果の人（session.display）のものでも出す。Slack から取って保存するのは、
// 今回の whoami が成功したとき（session.canFetch）の、その人（session.fetchAs）の名前空間にだけ。
// 前回と同じプロファイルのトークンが別のワークスペースのものに替わっていても、混ざらないようにするため
export function useDirectory<T>(dir: Directory<T>, session: Session) {
  const [entry, setEntry] = useState(() => read<T>(session.display, dir.key));
  const [isLoading, setIsLoading] = useState(false);
  // 取得中に再読み込みを押されても slack-cli を重ねて動かさず、実行中の取得を待つ
  const inFlight = useRef<Promise<void>>(undefined);

  const reload = useCallback(() => {
    // 取得してよい人が決まるまで（今回の whoami が成功するまで）、Slack から取らない
    if (!session.canFetch) return Promise.resolve();
    const { fetchAs } = session;
    if (inFlight.current) return inFlight.current;
    setIsLoading(true);
    inFlight.current = (async () => {
      try {
        setEntry(await fetchAndStore(dir, fetchAs));
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: `${dir.label}の一覧を更新できませんでした`,
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
    // 開いたときと、今回の whoami が成功したときに判定する
  }, [session.canFetch]);

  return { data: entry?.data, isLoading, reload };
}
