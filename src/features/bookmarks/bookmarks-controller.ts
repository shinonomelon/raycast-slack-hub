import { scopeKey, type Session } from "../../slack/identity.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import { fetchBookmarks } from "./bookmarks-api.ts";
import type { Bookmark } from "./bookmarks-model.ts";

export type BookmarksState = {
  status: "loading" | "ready" | "failed" | "auth-required";
  data: readonly Bookmark[];
  message?: string;
};
export class BookmarksController {
  private generation = 0;
  private pending?: AbortController;
  private api?: Session["api"];
  private account?: string;
  private channelId?: string;
  private data: readonly Bookmark[] = [];
  private readonly publish: (state: BookmarksState) => void;
  constructor(publish: (state: BookmarksState) => void) {
    this.publish = publish;
  }
  cancel() {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }
  invalidate() {
    this.cancel();
    this.data = [];
    this.publish({ status: "ready", data: [] });
  }
  async load(session: Session, channelId: string): Promise<boolean> {
    this.cancel();
    const generation = this.generation;
    const account = session.canFetch ? scopeKey(session.fetchAs) : undefined;
    if (
      this.api !== session.api ||
      this.account !== account ||
      this.channelId !== channelId
    )
      this.data = [];
    this.api = session.api;
    this.account = account;
    this.channelId = channelId;
    if (!session.canFetch) {
      this.publish({
        status: "auth-required",
        data: [],
        message: "認証を確認し、Slack Hubを開き直してください",
      });
      return false;
    }
    this.pending = new AbortController();
    this.publish({ status: "loading", data: this.data });
    try {
      const data = await fetchBookmarks(
        session.api,
        channelId,
        this.pending.signal,
      );
      if (generation !== this.generation) return false;
      this.data = data;
      this.publish({ status: "ready", data });
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.publish({
        status: "failed",
        data: this.data,
        message:
          error instanceof SlackApiError
            ? error.code === "missing_scope"
              ? "bookmarks:readを追加し、アプリを再インストールしてトークンを更新してください"
              : error.message
            : "ブックマーク一覧を取得できませんでした",
      });
      return false;
    }
  }
}
