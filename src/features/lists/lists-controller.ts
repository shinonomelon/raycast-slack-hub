import type { ApiCall } from "../../slack/slack-api.ts";
import type { Session } from "../../slack/identity.ts";
import { discoverLists, type DiscoveredList } from "./list-discovery.ts";
import { fetchItems } from "./lists-api.ts";
import type { SlackList, TaskItem } from "./lists-model.ts";

export const MAX_LIST_ITEMS = 10_000;
export const MAX_LIST_BYTES = 2 * 1024 * 1024;
export type ItemsState = {
  list?: SlackList;
  items: TaskItem[];
  cursor: string;
  loaded: boolean;
  busy: boolean;
  capped: boolean;
  error?: string;
};
export type DiscoveryState = {
  lists: DiscoveredList[];
  total: number;
  page: number;
  hasMore: boolean;
  capped: boolean;
  busy: boolean;
  error?: string;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "取得できませんでした";
// 認証APIのidentityと画面の世代を固定し、終了・対象変更後の遅延応答は破棄する。
export class ListsController {
  private generation = 0;
  private abort?: AbortController;
  private disposed = false;
  private readonly seenCursors = new Set<string>();
  state: ItemsState = {
    items: [],
    cursor: "",
    loaded: false,
    busy: false,
    capped: false,
  };
  private readonly api: ApiCall;
  private readonly teamId: string;
  private readonly listId: string;
  private readonly archived: boolean;
  private readonly changed: (state: ItemsState) => void;
  constructor(
    api: ApiCall,
    teamId: string,
    listId: string,
    archived: boolean,
    changed: (state: ItemsState) => void,
  ) {
    this.api = api;
    this.teamId = teamId;
    this.listId = listId;
    this.archived = archived;
    this.changed = changed;
  }
  private publish(state: ItemsState) {
    this.state = state;
    if (!this.disposed) this.changed(state);
  }
  async load(reset = false) {
    if (
      this.disposed ||
      (!reset &&
        (this.state.busy ||
          this.state.capped ||
          (this.state.loaded && !this.state.cursor)))
    )
      return;
    const generation = ++this.generation;
    if (reset) this.seenCursors.clear();
    this.abort?.abort();
    this.abort = new AbortController();
    const base = reset
      ? ({
          items: [],
          cursor: "",
          loaded: false,
          busy: false,
          capped: false,
        } as ItemsState)
      : this.state;
    this.publish({ ...base, busy: true, error: undefined });
    try {
      const page = await fetchItems(this.api, this.teamId, this.listId, {
        archived: this.archived,
        cursor: base.cursor,
        signal: this.abort.signal,
      });
      if (this.disposed || generation !== this.generation) return;
      if (
        page.cursor &&
        (this.seenCursors.has(page.cursor) || page.cursor === base.cursor)
      )
        throw new Error("同じページが返りました。再読込してください");
      if (
        base.list &&
        JSON.stringify(base.list.columns) !== JSON.stringify(page.list.columns)
      )
        throw new Error("取得中に列構成が変わりました。再読込してください");
      if (page.cursor) this.seenCursors.add(page.cursor);
      const map = new Map(base.items.map((item) => [item.id, item]));
      let bytes = Array.from(map.values()).reduce(
        (sum, item) =>
          sum + Buffer.byteLength(JSON.stringify(item.fields), "utf8"),
        0,
      );
      let capped = false;
      for (const item of page.items) {
        const prior = map.get(item.id);
        const nextBytes =
          bytes -
          (prior
            ? Buffer.byteLength(JSON.stringify(prior.fields), "utf8")
            : 0) +
          Buffer.byteLength(JSON.stringify(item.fields), "utf8");
        if (
          (!prior && map.size >= MAX_LIST_ITEMS) ||
          nextBytes > MAX_LIST_BYTES
        ) {
          capped = true;
          break;
        }
        map.set(item.id, item);
        bytes = nextBytes;
      }
      capped ||=
        Boolean(page.cursor) &&
        (map.size >= MAX_LIST_ITEMS || bytes >= MAX_LIST_BYTES);
      this.publish({
        list: page.list,
        items: Array.from(map.values()),
        cursor: page.cursor,
        loaded: true,
        busy: false,
        capped,
      });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.publish({ ...this.state, busy: false, error: message(error) });
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
  }
}
export class DiscoveryController {
  private generation = 0;
  private abort?: AbortController;
  private disposed = false;
  state: DiscoveryState = {
    lists: [],
    total: 0,
    page: 0,
    hasMore: true,
    capped: false,
    busy: false,
  };
  private readonly api: ApiCall;
  private readonly teamId: string;
  private readonly changed: (state: DiscoveryState) => void;
  constructor(
    api: ApiCall,
    teamId: string,
    changed: (state: DiscoveryState) => void,
  ) {
    this.api = api;
    this.teamId = teamId;
    this.changed = changed;
  }
  async load(reset = false) {
    if (
      this.disposed ||
      (!reset && (this.state.busy || !this.state.hasMore || this.state.capped))
    )
      return;
    const generation = ++this.generation;
    this.abort?.abort();
    this.abort = new AbortController();
    const base = reset
      ? ({
          lists: [],
          total: 0,
          page: 0,
          hasMore: true,
          capped: false,
          busy: false,
        } as DiscoveryState)
      : this.state;
    this.state = { ...base, busy: true, error: undefined };
    this.changed(this.state);
    try {
      const page = await discoverLists(
        this.api,
        this.teamId,
        base.page + 1,
        this.abort.signal,
      );
      if (this.disposed || generation !== this.generation) return;
      const map = new Map(base.lists.map((list) => [list.id, list]));
      for (const list of page.lists) map.set(list.id, list);
      this.state = {
        lists: Array.from(map.values()),
        total: page.total,
        page: page.page,
        hasMore: page.hasMore,
        capped: page.capped,
        busy: false,
      };
      this.changed(this.state);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.state = { ...this.state, busy: false, error: message(error) };
        this.changed(this.state);
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
  }
}
export function sessionStamp(session: Session): string {
  return `${session.display.teamId}:${session.display.userId}:${session.canFetch}`;
}
