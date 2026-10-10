import { Action, ActionPanel, Icon, List } from "@raycast/api";
import type { ReactNode } from "react";
import { compareTs, messageLink } from "../../slack/hits.ts";
import { toMarkdown, toPlain } from "../../slack/mrkdwn.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { DETAILS_SHORTCUT, REPLY_SHORTCUT } from "../hub/shortcuts.ts";
import { aiReasons } from "./reply-priority-ai.ts";
import { replyRoot, type ScoredReply } from "./reply-priority-view.ts";

export function ReplyPriorityRow({
  candidate,
  context,
  showDetail,
  onToggleDetail,
  onReply,
  onDismiss,
  onSnooze,
  onUndo,
  common,
  asOf,
  aiFailed,
}: {
  candidate: ScoredReply;
  context: MembershipContext;
  showDetail: boolean;
  onToggleDetail: () => void;
  onReply: () => void;
  onDismiss: () => void;
  onSnooze: (kind: "hour" | "tomorrow") => void;
  onUndo: () => void;
  common: ReactNode;
  asOf: string;
  aiFailed: boolean;
}) {
  const { hit } = candidate;
  const label = context.names.conversationLabel(hit);
  const sender = context.names.sender(hit);
  const pendingHours = Math.max(
    0,
    Math.floor((Number(asOf) - Number(candidate.firstPendingTs)) / 3600),
  );
  const wait = `${candidate.waitingLowerBound ? "待ち時間の下限 " : "待ち時間 "}${pendingHours}時間${candidate.waitingLowerBound ? "以上" : ""}`;
  const evidence =
    candidate.evidence.kind === "unknown"
      ? `確認待ち・${candidate.evidence.reason}`
      : "取得時点では後続の自分の投稿なし";
  const body = candidate.messages
    .toSorted((a, b) => compareTs(b.ts, a.ts))
    .map(
      (m) =>
        `**${m.userId === context.session.display.userId ? "自分" : (context.names.lookup.user?.(m.userId ?? "") ?? "投稿者")}** · ${new Date(Number(m.ts) * 1000).toLocaleString("ja-JP")}\n\n${toMarkdown(m.text, context.names.lookup)}`,
    )
    .join("\n\n---\n\n");
  return (
    <List.Item
      id={candidate.key}
      title={toPlain(hit.text, context.names.lookup) || "（本文なし）"}
      subtitle={showDetail ? undefined : `${sender} · ${label}`}
      accessories={[
        { text: wait },
        { text: aiFailed ? "AI判定失敗" : evidence },
      ]}
      detail={
        <List.Item.Detail
          markdown={`**${sender}** · ${label}\n\n${evidence} · ${wait}${candidate.ai ? `\n\n${aiReasons(candidate.ai).join("・")}\n\n必要性 ${candidate.ai.neededProbability.toFixed(2)} · 時間 ${candidate.ai.timeScore.toFixed(2)}/3 · 業務停止 ${candidate.ai.blockingScore.toFixed(2)}/2 · ${candidate.ai.model} / ${candidate.ai.promptVersion}` : ""}\n\n---\n\n${body || toMarkdown(hit.text, context.names.lookup)}`}
        />
      }
      actions={
        <ActionPanel>
          <Action.Open
            title="Open in Slack"
            target={messageLink(context.session.display.teamId, hit)}
            application="Slack"
            icon={Icon.ArrowRight}
          />
          <Action
            title={showDetail ? "Hide Details" : "Show Details"}
            icon={Icon.Sidebar}
            shortcut={DETAILS_SHORTCUT}
            onAction={onToggleDetail}
          />
          {replyRoot(candidate) && context.session.canFetch && (
            <Action
              title="Reply in Thread"
              icon={Icon.Reply}
              shortcut={REPLY_SHORTCUT}
              onAction={onReply}
            />
          )}
          {candidate.section === "hidden" ? (
            <Action
              title="除外・延期を取り消す"
              icon={Icon.Undo}
              onAction={onUndo}
            />
          ) : (
            <>
              <Action
                title="返信不要"
                icon={Icon.CheckCircle}
                onAction={onDismiss}
              />
              <Action
                title="あとで対応・1時間"
                icon={Icon.Clock}
                onAction={() => onSnooze("hour")}
              />
              <Action
                title="あとで対応・翌朝9時"
                icon={Icon.Clock}
                onAction={() => onSnooze("tomorrow")}
              />
            </>
          )}
          {common}
        </ActionPanel>
      }
    />
  );
}
