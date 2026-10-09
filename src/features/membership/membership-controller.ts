import { scopeKey, type Session } from "../../slack/identity.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import type { Conversation } from "../../shared/types.ts";
import {
  fetchChannelMembers,
  fetchPersonChannels,
  MEMBERSHIP_TIMEOUT_MS,
  checkRequest,
} from "./membership-api.ts";
import {
  membershipCache,
  type MembershipCache,
  type MembershipEntry,
} from "./membership-cache.ts";
import {
  intersectChannels,
  MAX_PEOPLE,
  targetKey,
  type MembershipData,
  type MembershipState,
  type MembershipTarget,
} from "./membership.ts";

export class MembershipController {
  private generation = 0;
  private abort?: AbortController;
  private session?: Session;
  private key?: string;
  private state: MembershipState = { status: "idle", data: [] };
  private publish: (state: MembershipState) => void;
  private cache: MembershipCache;
  private now: () => number;
  constructor(
    publish: (state: MembershipState) => void,
    cache: MembershipCache = membershipCache,
    now: () => number = Date.now,
  ) {
    this.publish = publish;
    this.cache = cache;
    this.now = now;
  }

  cancel(): void {
    this.generation++;
    this.abort?.abort();
  }

  async load(
    session: Session,
    target: MembershipTarget,
    refresh = false,
  ): Promise<void> {
    const key = targetKey(target);
    const same =
      session.canFetch &&
      this.session?.canFetch &&
      session.api === this.session.api &&
      scopeKey(session.fetchAs) === scopeKey(this.session.fetchAs) &&
      key === this.key;
    const previous =
      same && this.state.fetchedAt !== undefined ? this.state : undefined;
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.session = session;
    this.key = key;
    const current = () =>
      this.generation === generation && !controller.signal.aborted;
    const update = (state: MembershipState) => {
      if (current()) {
        this.state = state;
        this.publish(state);
      }
    };
    if (!session.canFetch) {
      update({
        status: "auth-required",
        data: [],
        error: "Slackの認証を確認し、Hubを開き直してください",
      });
      return;
    }
    const old = previous
      ? { data: previous.data, fetchedAt: previous.fetchedAt, previous: true }
      : { data: [] };
    update({ ...old, status: "loading" });
    const started = this.now();
    const request = {
      signal: controller.signal,
      deadline: started + MEMBERSHIP_TIMEOUT_MS,
      now: this.now,
    };
    const scope = scopeKey(session.fetchAs);
    const pending: { key: string; entry: MembershipEntry }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortWait: (() => void) | undefined;
    try {
      const work = async (): Promise<{
        data: MembershipData;
        fetchedAt: number;
      }> => {
        const get = async (
          entryKey: string,
          fetchData: () => Promise<MembershipData>,
        ): Promise<MembershipEntry> => {
          checkRequest(request);
          const cached = refresh
            ? undefined
            : this.cache.get(session.api, scope, entryKey, started);
          if (cached) return cached;
          const data = await fetchData();
          checkRequest(request);
          const entry = { data, fetchedAt: this.now() };
          pending.push({ key: entryKey, entry });
          return entry;
        };
        if (target.kind === "members") {
          return get(`members:${target.channelId}`, () =>
            fetchChannelMembers(session.api, target.channelId, request),
          );
        }
        const ids = [...new Set(target.userIds)];
        if (
          !ids.length ||
          ids.length > MAX_PEOPLE ||
          ids.length !== target.userIds.length
        )
          throw new SlackApiError(
            "configuration",
            "参加者は重複なく1人から5人まで指定してください",
          );
        const entries: MembershipEntry[] = [];
        for (const id of ids)
          entries.push(
            await get(`channels:${id}:public_channel,private_channel`, () =>
              fetchPersonChannels(session.api, id, request),
            ),
          );
        return {
          data: intersectChannels(
            entries.map((entry) => entry.data as readonly Conversation[]),
          ),
          fetchedAt: Math.min(...entries.map((entry) => entry.fetchedAt)),
        };
      };
      // APIの取消を無視する実装でも、操作全体の待ち時間を制限する。
      const timeout = new Promise<never>((_resolve, reject) => {
        abortWait = () =>
          reject(new SlackApiError("aborted", "通信を中断しました"));
        controller.signal.addEventListener("abort", abortWait, { once: true });
        timer = setTimeout(
          () =>
            reject(
              new SlackApiError(
                "timeout",
                "参加関係の取得が時間切れになりました",
              ),
            ),
          MEMBERSHIP_TIMEOUT_MS,
        );
      });
      const result = await Promise.race([work(), timeout]);
      if (!current()) return;
      checkRequest(request);
      for (const item of pending)
        this.cache.set(session.api, scope, item.key, item.entry);
      update({ status: result.data.length ? "ready" : "empty", ...result });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SlackApiError && error.kind === "aborted") {
        update({ status: "idle", data: [] });
        return;
      }
      if (error instanceof SlackApiError && error.kind === "rate_limited") {
        update({
          ...old,
          status: "rate-limited",
          retryAfter: error.retryAfter ?? 60,
          error: "Slack APIの回数制限です。待ってからRefreshしてください",
        });
      } else {
        // 任意の例外本文には認証情報が含まれうるため、画面へ渡さない。
        const message =
          error instanceof SlackApiError && error.kind === "timeout"
            ? "参加関係の取得が時間切れになりました"
            : error instanceof SlackApiError && error.code === "missing_scope"
              ? "参加関係の取得に必要なSlackの権限がありません"
              : "参加関係を取得できませんでした。Refreshで再試行してください";
        update({ ...old, status: "failed", error: message });
      }
      controller.abort();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortWait) controller.signal.removeEventListener("abort", abortWait);
    }
  }
}
