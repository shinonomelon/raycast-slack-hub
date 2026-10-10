import { compareTs, type Hit } from "../../slack/hits.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import { fetchHistoryPage, fetchThreadPage } from "./history-api.ts";
import {
  HISTORY_WINDOW_SECONDS,
  initialHistoryRange,
  mergeHistory,
  resolveThreadParent,
  threadParentCandidate,
  timestampAt,
  type HistoryMessage,
  type HistoryRange,
} from "./history-model.ts";

export type HistoryMode = "history" | "thread";
export type HistoryState = {
  status: "idle" | "loading" | "ready" | "failed" | "auth-required";
  messages: readonly HistoryMessage[];
  range?: HistoryRange;
  cursor?: string;
  parentTs?: string;
  error?: string;
  retryAt?: number;
  capped?: boolean;
  limited?: boolean;
  complete: boolean;
};
export const emptyHistory = (): HistoryState => ({
  status: "idle",
  messages: [],
  complete: false,
});
export class HistoryController {
  private generation = 0;
  private abort?: AbortController;
  private session?: Session;
  private hit?: Hit;
  private mode: HistoryMode = "history";
  private range?: HistoryRange;
  private openedAt = 0;
  private seenCursors = new Set<string>();
  private state: HistoryState = emptyHistory();
  private publish: (state: HistoryState) => void;
  private now: () => number;
  constructor(publish: (state: HistoryState) => void, now = Date.now) {
    this.publish = publish;
    this.now = now;
  }
  cancel() {
    this.generation++;
    this.abort?.abort();
  }
  async load(session: Session, hit: Hit, mode: HistoryMode) {
    this.cancel();
    this.session = session;
    this.hit = hit;
    this.mode = mode;
    this.openedAt = this.now();
    this.seenCursors.clear();
    this.range = initialHistoryRange(hit.ts, this.openedAt);
    this.state = { ...emptyHistory(), range: this.range };
    if (!session.canFetch) {
      this.state = {
        ...emptyHistory(),
        status: "auth-required",
        error: "認証を確認し、Hubを開き直してください",
      };
      this.publish(this.state);
      return;
    }
    await this.fetchPage();
  }
  async more() {
    if (
      !this.state.cursor ||
      this.state.status === "loading" ||
      this.state.capped
    )
      return;
    await this.fetchPage(this.state.cursor);
  }
  async extend(direction: "earlier" | "later") {
    if (
      this.mode !== "history" ||
      !this.state.complete ||
      !this.state.range ||
      this.state.capped ||
      this.state.status === "loading"
    )
      return;
    const previous = this.state.range;
    const seconds = (ts: string) => Number(ts.split(".")[0]);
    const oldest =
      direction === "earlier"
        ? Math.max(0, seconds(previous.oldest) - HISTORY_WINDOW_SECONDS)
        : seconds(previous.latest);
    const latest =
      direction === "earlier"
        ? seconds(previous.oldest)
        : Math.min(
            seconds(previous.latest) + HISTORY_WINDOW_SECONDS,
            this.openedAt / 1000,
          );
    if (latest <= oldest) return;
    this.range = { oldest: timestampAt(oldest), latest: timestampAt(latest) };
    this.state = { ...this.state, complete: false, cursor: undefined };
    this.seenCursors.clear();
    await this.fetchPage();
  }
  async retry() {
    if (this.state.status !== "failed" || this.state.capped) return;
    await this.fetchPage(this.state.cursor);
  }
  private async fetchPage(cursor?: string) {
    const session = this.session;
    const hit = this.hit;
    const range = this.range;
    if (
      !session?.canFetch ||
      !hit ||
      !range ||
      this.state.status === "loading" ||
      (this.state.retryAt ?? 0) > this.now()
    )
      return;
    this.cancel();
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const old = this.state;
    const account = scopeKey(session.fetchAs);
    const current = () =>
      generation === this.generation &&
      !abort.signal.aborted &&
      this.session?.canFetch &&
      this.session.api === session.api &&
      scopeKey(this.session.fetchAs) === account;
    const update = (state: HistoryState) => {
      if (current()) {
        this.state = state;
        this.publish(state);
      }
    };
    update({ ...old, status: "loading", error: undefined, retryAt: undefined });
    let failureState = old;
    try {
      const requestedTs = old.parentTs ?? hit.threadTs ?? hit.ts;
      let page =
        this.mode === "history"
          ? await fetchHistoryPage(
              session.api,
              hit,
              range,
              abort.signal,
              cursor,
            )
          : await fetchThreadPage(
              session.api,
              hit,
              requestedTs,
              timestampAt(this.openedAt / 1000),
              abort.signal,
              cursor,
            );
      if (!current()) return;
      let firstReply: readonly HistoryMessage[] = [];
      let confirmedParent: string | undefined;
      if (
        this.mode === "thread" &&
        !cursor &&
        !old.parentTs &&
        !hit.threadTs &&
        !resolveThreadParent(page, requestedTs)
      ) {
        const candidate = threadParentCandidate(page, requestedTs);
        if (candidate) {
          firstReply = page.messages;
          const partial = mergeHistory(old.messages, firstReply);
          failureState = {
            ...old,
            messages: partial.messages,
            parentTs: undefined,
            cursor: undefined,
            complete: false,
            capped: partial.capped,
            limited: old.limited || page.limited,
          };
          update({ ...failureState, status: "loading", error: undefined });
          if (partial.capped) {
            update({
              ...failureState,
              status: "ready",
              error:
                "本文の取得上限に達したため、親メッセージを確認していません",
            });
            return;
          }
          // 認証・対象が変わった場合には、親の確認要求自体も追加しない。
          if (!current()) return;
          const parentPage = await fetchThreadPage(
            session.api,
            hit,
            candidate,
            timestampAt(this.openedAt / 1000),
            abort.signal,
          );
          if (!current()) return;
          if (
            parentPage.messages[0]?.ts !== candidate ||
            resolveThreadParent(parentPage, candidate) !== candidate
          )
            throw new SlackApiError(
              "unreadable",
              "親メッセージを確認できませんでした",
            );
          confirmedParent = candidate;
          page = { ...parentPage, limited: page.limited || parentPage.limited };
        }
      }
      if (
        page.cursor &&
        (page.cursor === cursor || this.seenCursors.has(page.cursor))
      )
        throw new SlackApiError(
          "unreadable",
          "履歴の続きの応答を読み取れませんでした",
        );
      let parentTs = old.parentTs ?? confirmedParent;
      if (this.mode === "thread") {
        parentTs ??= resolveThreadParent(page, requestedTs);
        // 検索リンクで分かっている親と食い違う応答は採用しない。
        if (hit.threadTs && parentTs !== hit.threadTs) parentTs = undefined;
        if (
          parentTs &&
          page.messages.some(
            (message) =>
              message.ts !== parentTs && message.threadTs !== parentTs,
          )
        )
          throw new SlackApiError("unreadable", "別のスレッドの応答です");
      }
      const merged = mergeHistory(old.messages, [
        ...firstReply,
        ...page.messages,
      ]);
      if (page.cursor) this.seenCursors.add(page.cursor);
      const displayedRange =
        this.mode === "thread"
          ? {
              oldest: parentTs ?? merged.messages[0]?.ts ?? requestedTs,
              latest: timestampAt(this.openedAt / 1000),
            }
          : old.range
            ? {
                oldest:
                  compareTs(old.range.oldest, range.oldest) < 0
                    ? old.range.oldest
                    : range.oldest,
                latest:
                  compareTs(old.range.latest, range.latest) > 0
                    ? old.range.latest
                    : range.latest,
              }
            : range;
      update({
        status: "ready",
        messages: merged.messages,
        range: displayedRange,
        cursor: page.cursor,
        parentTs,
        capped: merged.capped,
        limited: old.limited || page.limited,
        complete:
          !page.cursor &&
          !merged.capped &&
          (this.mode !== "thread" || !!parentTs),
        error:
          this.mode === "thread" && !parentTs
            ? "親メッセージを確認できません。返信はSlackで行ってください"
            : undefined,
      });
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof SlackApiError && error.code === "missing_scope"
          ? "この会話の履歴権限がありません。対応するhistory scopeを追加し、再認証してください"
          : error instanceof SlackApiError && error.kind === "rate_limited"
            ? "Slack APIの回数制限です。待ってからRetryしてください"
            : failureState !== old
              ? "返信本文は取得済みですが、親メッセージを確認できません。返信はSlackで行ってください"
              : "現行本文を取得できませんでした。保管期限・アクセス権・認証を確認してください";
      update({
        ...failureState,
        status: "failed",
        error: message,
        retryAt:
          error instanceof SlackApiError && error.kind === "rate_limited"
            ? this.now() + (error.retryAfter ?? 60) * 1000
            : undefined,
      });
    }
  }
}
