import { Action, ActionPanel, Color, Icon, Keyboard, List } from "@raycast/api";
import type { ReactNode } from "react";
import { ComposeForm } from "./compose-form.tsx";
import { replyParentText, replyParentTitle, replyTargetOf } from "./compose.ts";
import { messageLink, type Hit } from "./hits.ts";
import type { Session } from "./identity.ts";
import { toMarkdown, toPlain } from "./mrkdwn.ts";
import type { Names } from "./names.ts";
import {
  FILTER_SHORTCUT,
  FILTER_SHORTCUT_ALT,
  HANDLED_SHORTCUT,
  REPLY_SHORTCUT,
} from "./shortcuts.ts";
import type { ReadState } from "./triage.ts";

// 読んだかの印。空欄の自分宛ての行と、対応済みの印が付いた検索結果の行に出す
const STATE_ACCESSORIES: Record<ReadState, List.Item.Accessory> = {
  unread: {
    icon: { source: Icon.CircleFilled, tintColor: Color.Red },
    tooltip: "未読",
  },
  read: {
    icon: { source: Icon.Circle, tintColor: Color.SecondaryText },
    tooltip: "既読",
  },
  thread: {
    icon: { source: Icon.SpeechBubble, tintColor: Color.Blue },
    tooltip: "スレッド返信（既読かどうかは判定しない）",
  },
  unknown: {
    icon: { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText },
    tooltip: "未確認（既読位置を取れていない）",
  },
  handled: {
    icon: { source: Icon.CheckCircle, tintColor: Color.Green },
    tooltip: "開いた・対応済み",
  },
};

// メッセージの行。空欄の一覧の自分宛てと、検索結果で使う。List.Section の中に置ける。
// ↵ で本文の全文をサイドバー（一覧の右の詳細）に出す・閉じる（読むだけなので、「開いた」の印は付けない）、
// ⌘↵ でその位置（スレッド返信ならスレッドの中）を Slack で開き（「開いた」の印を付ける）、⌘⇧↵ でスレッドに返信する。
// ⌘Y でもサイドバーを出せる。この行に置くのは、サイドバーが閉じているときだけ。出ているときの Hide Details（⌘Y）は、
// 呼び出し側がすべての行に置くもの（common に入っている）が受け持つ。同じ操作パネルに ⌘Y が2つ並ばないようにするため
export function MessageRow({
  session,
  id,
  hit,
  names,
  state,
  marked,
  showDetail,
  onToggleDetail,
  conversationFilter,
  senderFilter,
  onFilter,
  onOpen,
  onReplied,
  onToggleHandled,
  common,
}: {
  // 自分の情報。Slack で開くリンクのワークスペースの ID（session.display.teamId）と、返信のフォームに使う
  session: Session;
  // 行の id。同じメッセージが空欄の自分宛てと検索結果の両方に出ても重ならないよう、呼び出し側が決める
  id: string;
  hit: Hit;
  names: Names;
  // 読んだかの印。空欄の自分宛ては判定した状態。検索結果は、既読位置を取っていないので、対応済みの印が付いているときだけ
  state: ReadState | undefined;
  // 対応済みの印が付いているか（⌘⇧D で付け外しする）
  marked: boolean;
  // サイドバーが出ているか。出ているとき、行の subtitle と送信者は省く（詳細に出るため）
  showDetail: boolean;
  // サイドバーを出す・閉じる。読むだけなので、「開いた」の印は付けない（onOpen は呼ばない）
  onToggleDetail: () => void;
  // この会話・この送信者で絞るときに、検索欄に足す文字（in:#名前 など）。絞れないときは undefined で、その操作を出さない
  conversationFilter: string | undefined;
  senderFilter: string | undefined;
  onFilter: (filter: string) => void;
  // Slack で開いた（⌘↵）。呼び出し側が、印を付け、その会話の既読位置を忘れる。サイドバーを出し入れしたときは呼ばない
  onOpen: () => void;
  // 返信が届いた（成功のときだけ）。呼び出し側が、開いたときと同じ印を付ける
  onReplied: () => void;
  // ⌘⇧D：対応済みの印を付け外しする
  onToggleHandled: () => void;
  // Shift+Tab・⌘R・⌘⇧R など、どの行にも置く操作。サイドバーが出ているときの Hide Details（⌘Y）も入る
  common: ReactNode;
}) {
  const sender = names.sender(hit);
  const label = names.conversationLabel(hit);
  const date = new Date(Number(hit.ts.split(".")[0]) * 1000);
  // スレッドへの返信。送り先はこのメッセージのある会話で、親はこのメッセージのスレッド（返信なら、その親）
  const { target, threadTs } = replyTargetOf(hit);
  const parent = replyParentText({
    sender,
    time: date.toLocaleString("ja-JP"),
    body: toPlain(hit.text, names.lookup),
  });
  return (
    <List.Item
      id={id}
      title={toPlain(hit.text, names.lookup) || "（本文なし）"}
      subtitle={showDetail ? undefined : label}
      accessories={[
        ...(state ? [STATE_ACCESSORIES[state]] : []),
        ...(showDetail ? [] : [{ text: sender }]),
        { date, tooltip: date.toLocaleString("ja-JP") },
      ]}
      detail={
        <List.Item.Detail
          markdown={`**${sender}** · ${label} · ${date.toLocaleString("ja-JP")}\n\n${toMarkdown(hit.text, names.lookup)}`}
        />
      }
      actions={
        <ActionPanel>
          {/* 1番目の操作。ショートカットを付けないと、List では ↵ になる。
              サイドバーを出す・閉じるだけで、「開いた」の印は付けない（onOpen を呼ばない） */}
          <Action
            title={showDetail ? "Hide Details" : "Show Details"}
            icon={Icon.Sidebar}
            onAction={onToggleDetail}
          />
          {/* 2番目の操作。ショートカットを付けないと、List では ⌘↵ になる */}
          <Action.Open
            title="Open in Slack"
            icon={Icon.ArrowRight}
            target={messageLink(session.display.teamId, hit)}
            application="Slack"
            onOpen={onOpen}
          />
          <Action.Push
            title="Reply in Thread"
            icon={Icon.Reply}
            shortcut={REPLY_SHORTCUT}
            target={
              <ComposeForm
                session={session}
                target={target}
                destination={label}
                reply={{ threadTs, parentTitle: replyParentTitle(hit), parent }}
                onReplied={onReplied}
              />
            }
          />
          <Action
            title={marked ? "Unmark as Handled" : "Mark as Handled"}
            icon={marked ? Icon.Circle : Icon.CheckCircle}
            shortcut={HANDLED_SHORTCUT}
            onAction={onToggleHandled}
          />
          {conversationFilter ? (
            <Action
              title="Filter by This Conversation"
              icon={Icon.Filter}
              shortcut={FILTER_SHORTCUT}
              onAction={() => onFilter(conversationFilter)}
            />
          ) : null}
          {conversationFilter ? (
            <Action
              title="Filter by This Conversation"
              icon={Icon.Filter}
              shortcut={FILTER_SHORTCUT_ALT}
              onAction={() => onFilter(conversationFilter)}
            />
          ) : null}
          {senderFilter ? (
            <Action
              title="Filter by Sender"
              icon={Icon.Person}
              onAction={() => onFilter(senderFilter)}
            />
          ) : null}
          {/* ⌘Y でサイドバーを出す。閉じているときだけ置く。
              出ているときの Hide Details（⌘Y）は common に入っているので、ここにも置くと ⌘Y が2つになる */}
          {showDetail ? null : (
            <Action
              title="Show Details"
              icon={Icon.Sidebar}
              shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
              onAction={onToggleDetail}
            />
          )}
          {hit.permalink ? (
            <Action.OpenInBrowser
              title="Open Permalink in Browser"
              url={hit.permalink}
              shortcut={Keyboard.Shortcut.Common.Open}
            />
          ) : null}
          {hit.permalink ? (
            <Action.CopyToClipboard
              title="Copy Permalink"
              content={hit.permalink}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
          ) : null}
          {common}
        </ActionPanel>
      }
    />
  );
}
