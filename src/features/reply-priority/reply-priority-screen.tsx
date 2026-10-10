import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Detail,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { readReplyAISettings, readSettings } from "../../shared/settings.ts";
import { compareTs } from "../../slack/hits.ts";
import { SlackApiError } from "../../slack/slack-api.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { ComposeForm } from "../compose/compose-form.tsx";
import { replyParentText, replyParentTitle } from "../compose/compose.ts";
import { toPlain } from "../../slack/mrkdwn.ts";
import {
  rawMessage,
  snoozeUntil,
  type ReplyCandidate,
} from "./reply-priority.ts";
import {
  aiInputHash,
  createJevScorer,
  scoreAIRound,
  type AIInput,
  type AIResult,
} from "./reply-priority-ai.ts";
import {
  evidenceComplete,
  replyRoot,
  replySections,
  replyDisplayAfter,
  filterReplyRows,
  type ReplySection,
  type ScoredReply,
} from "./reply-priority-view.ts";
import { ReplyPriorityRow } from "./reply-priority-row.tsx";
import { useReplyPriority } from "./use-reply-priority.ts";
import type { ComponentProps } from "react";
import { guardedReplyRecheck } from "./reply-priority-guard.ts";
import { reusableReplyAI } from "./reply-priority-cache.ts";

// 押し出したフォームも設定変更時に外し、入力本文と前回原文を画面から消す。
function GuardedReplyForm({
  initialToken,
  initialAIKey,
  guard,
  ...props
}: ComponentProps<typeof ComposeForm> & {
  initialToken: string;
  initialAIKey: string;
  guard: () => boolean;
}) {
  const [valid, setValid] = useState(true);
  useEffect(() => {
    const check = () => {
      if (
        readSettings().accessToken !== initialToken ||
        readReplyAISettings().typesafeApiKey !== initialAIKey ||
        !guard()
      )
        setValid(false);
    };
    check();
    const interval = setInterval(check, 500);
    return () => clearInterval(interval);
  }, [initialToken, initialAIKey, guard]);
  return valid ? (
    <ComposeForm {...props} />
  ) : (
    <Detail markdown="認証設定が変わりました。Slack Hubを開き直してください。" />
  );
}

const titles: Record<ReplySection, string> = {
  review: "要確認",
  needed: "優先候補",
  "possibly-unnecessary": "返信不要の可能性",
  pending: "未返信候補",
  hidden: "除外・あとで対応",
};
type CachedAI = {
  hash: string;
  result: AIResult;
  scoredAt: number;
  applied: boolean;
};
export function ReplyPriorityScreen({
  context,
  initialToken,
}: {
  context: MembershipContext;
  initialToken: string;
}) {
  const { push } = useNavigation();
  const [days, setDays] = useState<1 | 7>(1);
  const [showDetail, setShowDetail] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const visibleRef = useRef<ScoredReply[]>([]);
  const [aiEnabled, setAIEnabled] = useState(false);
  const [aiApplied, setAIApplied] = useState(false);
  const consent = useRef(false);
  const [aiLoading, setAILoading] = useState(false);
  const [aiResults, setAIResults] = useState(new Map<string, AIResult>());
  const [staged, setStaged] = useState(new Map<string, AIResult>());
  const [failures, setFailures] = useState(new Set<string>());
  const cache = useRef(new Map<string, CachedAI>());
  const aiAbort = useRef<AbortController | undefined>(undefined);
  const aiGeneration = useRef(0);
  const aiBusy = useRef(false);
  const aiQueue = useRef<string[]>([]);
  const aiPausedUntil = useRef(0);
  const [aiMessage, setAIMessage] = useState("");
  function stopAI(clear = false) {
    aiGeneration.current++;
    aiAbort.current?.abort();
    aiBusy.current = false;
    setAILoading(false);
    if (clear) {
      consent.current = false;
      sourceRef.current?.saveAI(
        [...cache.current].map(([key, value]) => ({
          key,
          ...value,
          applied: false,
        })),
      );
      cache.current.clear();
      aiQueue.current = [];
      setAIResults(new Map());
      setStaged(new Map());
      setFailures(new Set());
      setAIEnabled(false);
      const next = replyDisplayAfter({ aiApplied, filter }, "disable");
      setAIApplied(next.aiApplied);
      setFilter(next.filter);
    }
  }
  const knownBotIds = useMemo(
    () => new Set(context.people.filter((p) => p.isBot).map((p) => p.id)),
    [context.people],
  );
  const source = useReplyPriority(
    context.session,
    days,
    initialToken,
    () => stopAI(true),
    knownBotIds,
  );
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const persistAI = () =>
    sourceRef.current.saveAI(
      [...cache.current].map(([key, value]) => ({ key, ...value })),
    );
  useEffect(
    () => () => {
      aiGeneration.current++;
      aiAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    stopAI();
    setStaged(new Map());
    setAIResults(new Map());
    setFailures(new Set());
    const next = replyDisplayAfter({ aiApplied, filter }, "refresh");
    setAIApplied(next.aiApplied);
    setFilter(next.filter);
  }, [days]);
  useEffect(() => {
    if (!source.cacheEpoch || !source.guard()) return;
    const entries = source.loadAI();
    cache.current = new Map(entries.map(({ key, ...entry }) => [key, entry]));
    const applied = new Map(
      entries
        .filter(
          (entry) =>
            entry.applied &&
            source.snapshot.candidates.some(
              (c) =>
                c.key === entry.key && aiInputHash(inputOf(c)) === entry.hash,
            ),
        )
        .map((entry) => [entry.key, entry.result]),
    );
    setAIResults(applied);
    const mode = applied.size > 0;
    const next = replyDisplayAfter(
      { aiApplied, filter },
      mode ? "apply" : "refresh",
    );
    setAIApplied(next.aiApplied);
    setFilter(next.filter);
  }, [source.cacheEpoch]);
  function inputOf(c: ReplyCandidate): AIInput {
    return {
      messages: c.messages.map((m) => ({
        ts: m.ts,
        text: m.text,
        userId: m.userId ?? "unknown",
        reactions: m.reactions,
      })),
      rootTs: c.hit.threadTs ?? c.messages[0]?.ts ?? c.anchorTs,
      anchorTs: c.anchorTs,
      selfId: context.session.display.userId,
      asOf: sourceRef.current.snapshot.asOf,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      evidenceComplete: evidenceComplete(c),
      fileOnly: c.messages.every((m) => !m.text.trim()),
    };
  }
  async function score() {
    if (aiBusy.current || source.loading || !source.guard()) return;
    if (aiPausedUntil.current > Date.now()) {
      setAIMessage(
        `${new Date(aiPausedUntil.current).toLocaleTimeString("ja-JP")}までAI判定を停止します`,
      );
      return;
    }
    for (const { key, ...entry } of source.loadAI())
      if (!cache.current.has(key)) cache.current.set(key, entry);
    const key = readReplyAISettings().typesafeApiKey.trim();
    if (!key) {
      setAIMessage(
        "TypeSafe API Keyを設定してください。AIなしでも候補を確認できます",
      );
      await openExtensionPreferences();
      return;
    }
    if (!consent.current) {
      const accepted = await confirmAlert({
        title: "TypeSafeへ会話本文を送信しますか？",
        message:
          "表示候補の本文・投稿時刻・相対化した投稿者情報をTypeSafeへ送信します。本文に含まれる個人情報は自動では除去しません。1回最大20候補です。Slackトークンは送りません。無効化で今後の送信は止まりますが、送信済み本文は取り消せません。",
        primaryAction: {
          title: "有効にして判定",
          style: Alert.ActionStyle.Default,
        },
        dismissAction: { title: "AIなしで確認" },
      });
      if (!accepted || !source.guard()) return;
      consent.current = true;
    }
    setAIEnabled(true);
    aiBusy.current = true;
    setAILoading(true);
    setAIMessage("");
    const id = ++aiGeneration.current;
    aiAbort.current = new AbortController();
    if (sourceRef.current.loading || !sourceRef.current.guard()) {
      aiBusy.current = false;
      setAILoading(false);
      return;
    }
    const items = visibleRef.current
      .filter((c) => c.section !== "hidden")
      .map((c) => ({ key: c.key, input: inputOf(c) }));
    const ready = new Map<string, AIResult>();
    const pending = items.filter((item) => {
      const old = cache.current.get(item.key);
      if (
        old &&
        reusableReplyAI(
          { key: item.key, ...old },
          aiInputHash(item.input),
          Date.now(),
        )
      ) {
        ready.set(item.key, old.result);
        return false;
      }
      return true;
    });
    const hashes = new Map(
      pending.map((item) => [item.key, aiInputHash(item.input)]),
    );
    const order = new Map(aiQueue.current.map((key, i) => [key, i]));
    pending.sort(
      (a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity),
    );
    try {
      const scorer = createJevScorer(key);
      const round = await scoreAIRound(
        pending,
        {
          score: (input, signal) =>
            sourceRef.current.guard() && consent.current
              ? scorer.score(input, signal)
              : Promise.resolve({
                  kind: "failed" as const,
                  reason: "aborted" as const,
                }),
        },
        aiAbort.current.signal,
      );
      if (id !== aiGeneration.current || !source.guard() || !consent.current)
        return;
      const errors = new Set(failures);
      for (const [key, outcome] of round.results) {
        if (outcome.kind === "ok") {
          ready.set(key, outcome.result);
          cache.current.set(key, {
            hash: hashes.get(key)!,
            result: outcome.result,
            scoredAt: Date.now(),
            applied: false,
          });
          errors.delete(key);
        } else {
          errors.add(key);
          if (outcome.reason === "rate")
            aiPausedUntil.current =
              Date.now() + (outcome.retryAfterMs ?? 60000);
        }
      }
      persistAI();
      aiQueue.current = [
        ...round.remaining,
        ...pending
          .filter((item) => errors.has(item.key))
          .map((item) => item.key),
      ];
      setFailures(errors);
      setStaged(ready);
      setAIMessage(
        round.stopped === "auth"
          ? "TypeSafeの認証に失敗しました。設定のAPI Keyを確認・更新してからSlack Hubを開き直してください"
          : round.stopped === "rate"
            ? "AIの回数制限に当たりました。候補は残っています"
            : round.remaining.length
              ? `未判定 ${round.remaining.length}件。次の判定で続きます`
              : errors.size
                ? "AI判定できませんでした。再試行できます"
                : "AI判定を反映すると順序を更新します",
      );
    } catch {
      if (id === aiGeneration.current)
        setAIMessage("AI判定できませんでした。候補は残っています");
    } finally {
      if (id === aiGeneration.current) {
        aiBusy.current = false;
        setAILoading(false);
      }
    }
  }
  async function openReply(candidate: ReplyCandidate) {
    if (!source.guard()) return;
    const latest = source
      .current()
      ?.candidates.find((c) => c.key === candidate.key);
    if (!latest || !replyRoot(latest)) return;
    if (
      source.snapshot.pausedUntil > Date.now() ||
      source.store.loadPause() > Date.now()
    ) {
      await showToast({
        title: "Slackの回数制限で停止中です",
        style: Toast.Style.Failure,
      });
      return;
    }
    let previous = false;
    const normalDm = latest.hit.channelKind === "im" && !latest.hit.threadTs;
    const rechecked = await guardedReplyRecheck(
      () => sourceRef.current.recheckState(latest.key),
      (signal) =>
        source.api(
          normalDm ? "conversations.history" : "conversations.replies",
          normalDm
            ? {
                channel: latest.hit.channelId,
                oldest: latest.anchorTs,
                inclusive: false,
                limit: 15,
              }
            : {
                channel: latest.hit.channelId,
                ts: replyRoot(latest),
                limit: 15,
              },
          { timeoutMs: 15000, signal },
        ),
    );
    if (!rechecked) return;
    try {
      if (rechecked.kind === "failed") throw rechecked.error;
      const data = rechecked.value;
      const messages = Array.isArray(data.messages)
        ? data.messages.map(rawMessage).filter((m) => m !== undefined)
        : [];
      if (
        messages.some(
          (m) =>
            m.userId === context.session.display.userId &&
            compareTs(m.ts, latest.anchorTs) > 0 &&
            (!normalDm || !m.threadTs || m.threadTs === m.ts),
        )
      ) {
        await showToast({
          title: "自分の後続投稿が見つかりました",
          message: "一覧を更新してから確認してください",
          style: Toast.Style.Success,
        });
        return;
      }
      previous = Boolean(
        data.has_more ||
        (data.response_metadata as { next_cursor?: string } | undefined)
          ?.next_cursor ||
        !messages.length,
      );
    } catch (error) {
      previous = true;
      if (error instanceof SlackApiError && error.kind === "rate_limited")
        source.store.savePause(Date.now() + (error.retryAfter ?? 60) * 1000);
    }
    if (!source.guard()) return;
    push(
      <GuardedReplyForm
        initialToken={initialToken}
        initialAIKey={readReplyAISettings().typesafeApiKey}
        guard={source.guard}
        session={{ ...context.session, api: source.api }}
        target={{ kind: "conversation", id: latest.hit.channelId }}
        destination={context.names.conversationLabel(latest.hit)}
        reply={{
          threadTs: replyRoot(latest)!,
          parentTitle: replyParentTitle(latest.hit),
          parent: `${previous ? "前回の確認。最新状態を確認できませんでした。\n" : "フォームを開く直前に確認しました。\n"}${replyParentText({ sender: context.names.sender(latest.hit), time: new Date(Number(latest.anchorTs) * 1000).toLocaleString("ja-JP"), body: toPlain(latest.messages.find((m) => m.ts === latest.anchorTs)?.text ?? latest.hit.text, context.names.lookup) })}`,
        }}
        onReplied={() => {
          void sourceRef.current.refresh();
        }}
      />,
    );
  }
  const currentResults = new Map(
    source.snapshot.candidates.flatMap((c) => {
      const result = aiResults.get(c.key);
      return result &&
        cache.current.get(c.key)?.hash === aiInputHash(inputOf(c))
        ? [[c.key, result] as const]
        : [];
    }),
  );
  const rows = replySections(
    source.snapshot.candidates,
    source.marks,
    currentResults,
    aiApplied,
    Date.now(),
  );
  const visibleRows = filterReplyRows(
    rows,
    filter,
    searchText,
    (c) =>
      `${toPlain(c.hit.text, context.names.lookup)} ${context.names.sender(c.hit)} ${context.names.conversationLabel(c.hit)}`,
  );
  visibleRef.current = visibleRows;
  const sections: ReplySection[] = aiApplied
    ? ["review", "needed", "possibly-unnecessary", "hidden"]
    : ["review", "pending", "hidden"];
  const common = (
    <>
      <Action
        title="Reload Reply Candidates"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => {
          stopAI();
          setStaged(new Map());
          setAIResults(new Map());
          const next = replyDisplayAfter({ aiApplied, filter }, "refresh");
          setAIApplied(next.aiApplied);
          setFilter(next.filter);
          void source.refresh();
        }}
      />
      {source.snapshot.pendingCount > 0 && (
        <Action
          title="続きを確認"
          icon={Icon.ArrowRight}
          onAction={() => {
            const pausedUntil = Math.max(
              source.snapshot.pausedUntil,
              source.store.loadPause(),
            );
            if (pausedUntil > Date.now()) {
              void showToast({
                style: Toast.Style.Failure,
                title: "Slackの回数制限で停止中です",
                message: `${new Date(pausedUntil).toLocaleTimeString("ja-JP")}以降に「続きを確認」を実行してください`,
              });
              return;
            }
            if (!source.loading) void source.continueScan();
          }}
        />
      )}
      <Action
        title="過去24時間"
        icon={Icon.Clock}
        onAction={() => {
          if (days !== 1) {
            source.cancelScan();
            stopAI();
            setDays(1);
          }
        }}
      />
      <Action
        title="過去7日"
        icon={Icon.Calendar}
        onAction={() => {
          if (days !== 7) {
            source.cancelScan();
            stopAI();
            setDays(7);
          }
        }}
      />
      <Action
        title={aiLoading ? "AI判定を中断" : "AIで並べる・再試行"}
        icon={Icon.Stars}
        onAction={() => {
          if (aiLoading) {
            stopAI();
            setAIMessage("AI判定を中断しました。再試行できます");
          } else void score();
        }}
      />
      {staged.size > 0 && !aiLoading && (
        <Action
          title="AI判定を反映"
          icon={Icon.CheckCircle}
          onAction={() => {
            if (source.guard()) {
              const accepted = new Map(
                [...staged].filter(([key]) => {
                  const value = cache.current.get(key);
                  const candidate = source.snapshot.candidates.find(
                    (c) => c.key === key,
                  );
                  return (
                    value &&
                    candidate &&
                    reusableReplyAI(
                      { key, ...value },
                      aiInputHash(inputOf(candidate)),
                      Date.now(),
                    )
                  );
                }),
              );
              if (!accepted.size) {
                setAIMessage(
                  "判定が古くなりました。更新してから再判定してください",
                );
                setStaged(new Map());
                return;
              }
              setAIResults(new Map([...aiResults, ...accepted]));
              setStaged(new Map());
              for (const key of accepted.keys()) {
                const value = cache.current.get(key);
                if (value) cache.current.set(key, { ...value, applied: true });
              }
              persistAI();
              const next = replyDisplayAfter({ aiApplied, filter }, "apply");
              setAIApplied(next.aiApplied);
              setFilter(next.filter);
            }
          }}
        />
      )}
      {(aiEnabled || aiApplied) && (
        <Action
          title="AIを無効にする"
          icon={Icon.XMarkCircle}
          onAction={() => stopAI(true)}
        />
      )}
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
  const description = source.invalidated
    ? "認証設定が変わりました。Slack Hubを開き直してください"
    : !context.session.canFetch
      ? "認証が確定していないため取得できません。Slack Hubを開き直してください"
      : aiMessage;
  const slackPausedUntil = Math.max(
    source.snapshot.pausedUntil,
    source.store.loadPause(),
  );
  const problem =
    source.invalidated || !context.session.canFetch
      ? description
      : slackPausedUntil > Date.now()
        ? `Slackの回数制限。${new Date(slackPausedUntil).toLocaleTimeString("ja-JP")}以降に「続きを確認」`
        : aiPausedUntil.current > Date.now()
          ? `AIの回数制限。${new Date(aiPausedUntil.current).toLocaleTimeString("ja-JP")}以降に「AIで並べる・再試行」`
          : /できません|失敗|中断|古くなりました|設定してください/.test(
                aiMessage,
              )
            ? aiMessage
            : "";
  return (
    <List
      navigationTitle="返信待ち"
      isLoading={source.loading || aiLoading}
      isShowingDetail={showDetail}
      selectedItemId={selected}
      onSelectionChange={(id) => setSelected(id ?? undefined)}
      searchBarPlaceholder="返信待ちを検索"
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="返信待ちの表示"
          value={filter}
          onChange={setFilter}
        >
          <List.Dropdown.Item value="all" title="すべての候補" />
          {sections.map((section) => (
            <List.Dropdown.Item
              key={section}
              value={section}
              title={`${titles[section]} ${rows.filter((r) => r.section === section).length}件`}
            />
          ))}
        </List.Dropdown>
      }
    >
      {problem && visibleRows.length > 0 && (
        <List.Item
          id="reply-priority-problem"
          title={problem}
          icon={Icon.ExclamationMark}
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      )}
      <List.EmptyView
        title="返信待ち候補はありません"
        description={problem || description}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      {sections
        .filter((s) => (filter === "all" ? s !== "hidden" : s === filter))
        .map((section) => (
          <List.Section key={section} title={titles[section]}>
            {visibleRows
              .filter((r) => r.section === section)
              .map((c) => (
                <ReplyPriorityRow
                  key={c.key}
                  candidate={c}
                  context={context}
                  showDetail={showDetail}
                  onToggleDetail={() => setShowDetail((v) => !v)}
                  onReply={() => void openReply(c)}
                  onDismiss={() => {
                    if (source.guard()) {
                      source.store.set(c.key, {
                        kind: "dismissed",
                        anchorTs: c.anchorTs,
                        at: Date.now(),
                      });
                      source.reloadMarks();
                    }
                  }}
                  onSnooze={(kind) => {
                    if (source.guard()) {
                      const now = Date.now();
                      source.store.set(c.key, {
                        kind: "snoozed",
                        anchorTs: c.anchorTs,
                        at: now,
                        until: snoozeUntil(kind, now),
                      });
                      source.reloadMarks();
                    }
                  }}
                  onUndo={() => {
                    if (source.guard()) {
                      source.store.remove(c.key);
                      source.reloadMarks();
                    }
                  }}
                  common={common}
                  asOf={source.snapshot.asOf}
                  aiFailed={failures.has(c.key)}
                />
              ))}
          </List.Section>
        ))}
    </List>
  );
}
