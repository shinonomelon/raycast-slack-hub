import { object, type ApiCall } from "../../slack/slack-api.ts";
import { LIST_ID, slackListUrl, type SlackList } from "./lists-model.ts";
import { rankItems } from "../search/search.ts";
export type DiscoveredList = Pick<SlackList, "id" | "title" | "url">;
export type DiscoveryPage = {
  lists: DiscoveredList[];
  total: number;
  page: number;
  hasMore: boolean;
  capped: boolean;
};
// Legacy検索の発見だけを隔離し、項目の取得や任意URLへの通信と混ぜない。
export async function discoverLists(
  api: ApiCall,
  teamId: string,
  page = 1,
  signal?: AbortSignal,
): Promise<DiscoveryPage> {
  if (!Number.isInteger(page) || page < 1 || page > 100)
    throw new Error("検索ページの上限は100です");
  const raw = await api(
    "search.files",
    { query: "type:list", count: 100, page },
    { signal },
  );
  const files = object(raw.files);
  if (!Array.isArray(files.matches))
    throw new Error("リスト検索の応答を読み取れませんでした");
  const matches = files.matches.slice(0, 100).map(object);
  const lists = matches.flatMap((file): DiscoveredList[] => {
    if (
      typeof file.id !== "string" ||
      !LIST_ID.test(file.id) ||
      !(
        file.filetype === "list" ||
        file.mimetype === "application/vnd.slack-list" ||
        file.mode === "list"
      )
    )
      return [];
    return [
      {
        id: file.id,
        title:
          typeof file.title === "string"
            ? file.title
            : typeof file.name === "string"
              ? file.name
              : file.id,
        url: slackListUrl(teamId, file.id),
      },
    ];
  });
  const paging = object(files.paging);
  const pages = Number(paging.pages ?? object(files.pagination).page_count);
  const total = Number(
    paging.total ?? files.total ?? object(files.pagination).total_count,
  );
  if (
    !Number.isFinite(pages) ||
    pages < 0 ||
    !Number.isFinite(total) ||
    total < 0
  )
    throw new Error("検索ページ情報を読み取れませんでした");
  return {
    lists,
    total,
    page,
    hasMore: page < pages && page < 100,
    capped: page >= 100 && page < pages,
  };
}
export function rankLists(
  lists: readonly DiscoveredList[],
  text: string,
): DiscoveredList[] {
  return rankItems(
    lists.map((list) => ({
      ...list,
      kind: "channel" as const,
      keywords: [list.title],
    })),
    text,
    lists.length,
  );
}
export function listIdFromInput(input: string, teamId: string): string {
  const value = input.trim();
  if (LIST_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "SlackのリストURLまたはFで始まるリストIDを入力してください",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "app.slack.com" ||
      /^[a-z0-9-]+\.slack\.com$/.test(url.hostname)
    )
  )
    throw new Error("SlackのHTTPSリストURLを入力してください");
  const original = url;
  const redir = url.searchParams.get("redir");
  if (url.pathname === "/" && redir?.startsWith("/lists/")) {
    url = new URL(redir, url.origin);
    if (url.origin !== original.origin)
      throw new Error("リストURLの形式ではありません");
  }
  const path = /^\/lists\/(T[A-Z0-9]+)\/(F[A-Z0-9]+)\/?$/.exec(url.pathname);
  if (!path) throw new Error("SlackのリストURLの形式ではありません");
  const queryTeams = [
    ...url.searchParams.getAll("team_id"),
    ...original.searchParams.getAll("team_id"),
  ];
  const queryLists = [
    ...url.searchParams.getAll("list_id"),
    ...original.searchParams.getAll("list_id"),
  ];
  if (path[1] !== teamId || queryTeams.some((value) => value !== teamId))
    throw new Error("現在のワークスペースと異なるリストURLです");
  if (queryLists.some((value) => value !== path[2]))
    throw new Error("リストURLのIDが一致しません");
  return path[2];
}
