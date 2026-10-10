import {
  readAccountSearchPause,
  writeAccountSearchPause,
} from "../search/gate-store.ts";
import { scopeFingerprint, type ResolvedScope } from "../search-scope/model.ts";
import { Cache } from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSettings, readReplyAISettings } from "../../shared/settings.ts";
import { SlackApiError, type ApiCall } from "../../slack/slack-api.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import {
  type ReplyScan,
  type ReplyScanSnapshot,
} from "./reply-priority-fetch.ts";
import {
  createReplyPriorityStore,
  replyPriorityNamespace,
} from "./reply-priority-store.ts";
import { createReplyCredentialGate } from "./reply-priority-guard.ts";
import {
  createReplyDecisionCache,
  openCachedReplyScan,
  replyBinding,
  REPLY_DECISION_NAMESPACE,
} from "./reply-priority-cache.ts";

const empty = (): ReplyScanSnapshot => ({
  candidates: [],
  asOf: "",
  since: "",
  pendingCount: 0,
  pausedUntil: 0,
  searchCapped: false,
  searchIncomplete: false,
  calls: { search: 0, history: 0, replies: 0, auth: 0, permalink: 0 },
});
export function useReplyPriority(
  session: Session,
  days: 1 | 7,
  token: string,
  onInvalidate: () => void,
  knownBotIds?: ReadonlySet<string>,
  resolvedScope: ResolvedScope = {
    channelIds: "all",
    fingerprint: scopeFingerprint("all"),
  },
  scopeBlocked = false,
) {
  const currentScope = useRef(resolvedScope.fingerprint);
  currentScope.current = resolvedScope.fingerprint;
  const snapshotScope = useRef(resolvedScope.fingerprint);
  const [aiKey] = useState(() => readReplyAISettings().typesafeApiKey);
  const [snapshot, setSnapshot] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const [marks, setMarks] = useState(() => ({}));
  const generation = useRef(0);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const scan = useRef<ReplyScan | undefined>(undefined);
  const invalidateRef = useRef(onInvalidate);
  invalidateRef.current = onInvalidate;
  const store = useMemo(
    () =>
      createReplyPriorityStore(
        new Cache({ namespace: replyPriorityNamespace(session.display) }),
        scopeKey(session.display),
      ),
    [session.display.teamId, session.display.userId],
  );
  const decisionCache = useMemo(
    () =>
      createReplyDecisionCache(
        new Cache({ namespace: REPLY_DECISION_NAMESPACE }),
        replyBinding(
          { teamId: session.display.teamId, userId: session.display.userId },
          token,
          aiKey,
        ),
        Date.now,
        resolvedScope,
      ),
    [
      session.display.teamId,
      session.display.userId,
      token,
      aiKey,
      resolvedScope.fingerprint,
    ],
  );
  const credentialGate = useMemo(
    () =>
      createReplyCredentialGate(
        { token, aiKey },
        () => ({
          token: readSettings().accessToken,
          aiKey: readReplyAISettings().typesafeApiKey,
        }),
        () => {
          generation.current++;
          controller.current?.abort();
          scan.current = undefined;
          decisionCache.invalidate();
          if (alive.current) {
            setSnapshot(empty());
            setMarks({});
            setLoading(false);
            setInvalidated(true);
          }
          invalidateRef.current();
        },
      ),
    [token, aiKey, decisionCache],
  );
  const guard = useCallback(() => {
    return (
      credentialGate.check() &&
      alive.current &&
      session.canFetch &&
      !scopeBlocked &&
      currentScope.current === resolvedScope.fingerprint
    );
  }, [
    session.canFetch,
    credentialGate,
    scopeBlocked,
    resolvedScope.fingerprint,
  ]);
  // フォームを開いた後も、投稿を含む各API呼び出しの直前に設定変更を確認する。
  const api: ApiCall = useCallback(
    async (method, params, options) => {
      if (!guard())
        throw new SlackApiError(
          "configuration",
          "認証設定が変わりました。Slack Hubを開き直してください",
        );
      const result = await session.api(method, params, options);
      if (!guard())
        throw new SlackApiError("aborted", "認証設定が変わりました");
      return result;
    },
    [session.api, guard],
  );
  const run = useCallback(
    async (fresh: boolean, preferCache = false) => {
      if (!guard()) return;
      let id = generation.current;
      if (fresh) {
        controller.current?.abort();
        id = ++generation.current;
        controller.current = new AbortController();
        setSnapshot(empty());
        snapshotScope.current = resolvedScope.fingerprint;
        const opened = openCachedReplyScan(
          decisionCache,
          days,
          {
            api,
            identity: session.display,
            knownBotIds,
            scope: resolvedScope,
            signal: controller.current.signal,
            loadPause: () =>
              Math.max(
                store.loadPause(),
                readAccountSearchPause(scopeKey(session.display))?.until ?? 0,
              ),
            savePause: (until) => {
              store.savePause(until);
              writeAccountSearchPause(scopeKey(session.display), {
                until,
                cause: "rate_limited",
              });
            },
            onUpdate: (next) => {
              if (guard() && generation.current === id) setSnapshot(next);
            },
          },
          !preferCache,
          () => guard() && generation.current === id,
        );
        scan.current = opened.scan;
        setFromCache(opened.fromCache);
        setCacheEpoch((current) => current + 1);
        if (opened.fromCache) {
          setSnapshot(opened.scan.snapshot());
          setLoading(false);
          return;
        }
      }
      if (!scan.current) return;
      setLoading(true);
      try {
        if (fresh) await scan.current.start(days);
        else await scan.current.continue();
      } finally {
        if (guard() && generation.current === id) setLoading(false);
      }
    },
    [api, guard, days, session.display, store, decisionCache],
  );
  useEffect(() => {
    alive.current = true;
    setMarks(store.load());
    void run(true, true);
    const interval = setInterval(guard, 500);
    return () => {
      alive.current = false;
      generation.current++;
      controller.current?.abort();
      clearInterval(interval);
    };
  }, [days, session.canFetch, store, guard, resolvedScope.fingerprint]);
  return {
    snapshot:
      !scopeBlocked && snapshotScope.current === resolvedScope.fingerprint
        ? snapshot
        : empty(),
    loading:
      !scopeBlocked &&
      snapshotScope.current === resolvedScope.fingerprint &&
      loading,
    invalidated,
    fromCache,
    cacheEpoch,
    loadAI: () => (guard() ? decisionCache.loadAI(days) : []),
    saveAI: (entries: Parameters<typeof decisionCache.saveAI>[1]) => {
      if (guard()) decisionCache.saveAI(days, entries);
    },
    guard,
    api,
    store,
    marks,
    reloadMarks: () => {
      if (guard()) setMarks(store.load());
    },
    refresh: () => run(true),
    continueScan: () => run(false),
    cancelScan: () => {
      generation.current++;
      controller.current?.abort();
      scan.current = undefined;
      setSnapshot(empty());
      setLoading(false);
    },
    recheckState: (key: string) => {
      const candidate = scan.current
        ?.snapshot()
        .candidates.find((c) => c.key === key);
      return guard() && candidate && controller.current
        ? {
            generation: generation.current,
            anchorTs: candidate.anchorTs,
            signal: controller.current.signal,
          }
        : undefined;
    },
    current: () => (guard() ? scan.current?.snapshot() : undefined),
  };
}
