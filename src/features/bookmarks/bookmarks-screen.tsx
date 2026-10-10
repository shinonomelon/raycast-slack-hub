import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Icon,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { slackAppChannelLink } from "../compose/compose.ts";
import { escapeDetail } from "../hub/row-detail.ts";
import { DETAILS_SHORTCUT } from "../hub/shortcuts.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { useWriteOperation } from "../operations/use-write-operation.ts";
import type { WriteOutcome } from "../operations/write-outcome.ts";
import { BookmarkForm } from "./bookmark-form.tsx";
import { removeBookmark } from "./bookmarks-api.ts";
import { completeBookmarkWrite } from "./bookmarks-write.ts";
import {
  bookmarkUrl,
  deleteBookmarkConfirmation,
  type Bookmark,
} from "./bookmarks-model.ts";
import { useBookmarks } from "./use-bookmarks.ts";

type Props = { session: Session; channel: { id: string; name: string } };
export function BookmarksScreen(props: Props) {
  if (!FEATURE_GATES.bookmarksRead)
    return <ApiGateNotice title="ブックマークの閲覧" />;
  return <ReadableBookmarksScreen {...props} />;
}
function ReadableBookmarksScreen({ session, channel }: Props) {
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const state = useBookmarks(session, channel.id);
  const write = useWriteOperation(session);
  const latest = useRef({
    api: session.api,
    account: scopeKey(session.display),
    channelId: channel.id,
    canFetch: session.canFetch,
  });
  latest.current = {
    api: session.api,
    account: scopeKey(session.display),
    channelId: channel.id,
    canFetch: session.canFetch,
  };
  const deletionPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const rows = state.data.filter((bookmark) =>
    bookmark.title
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase().trim()),
  );
  async function onWritten(outcome: WriteOutcome): Promise<boolean> {
    // 子画面が開いた時の認証・対象を使う。閉じた親や別の対象へ通知しない。
    if (
      !mounted.current ||
      !latest.current.canFetch ||
      latest.current.api !== session.api ||
      latest.current.account !== scopeKey(session.display) ||
      latest.current.channelId !== channel.id
    )
      return false;
    if (outcome.kind === "failed") return false;
    if (outcome.kind === "unconfirmed") setUncertain(true);
    state.invalidate();
    return outcome.kind === "succeeded" ? state.refresh() : false;
  }
  async function remove(bookmark: Bookmark) {
    if (
      !FEATURE_GATES.bookmarksWrite ||
      !session.canFetch ||
      write.busy ||
      write.unconfirmed ||
      uncertain ||
      deletionPending.current
    )
      return;
    deletionPending.current = true;
    const start = { ...latest.current };
    const isCurrent = () =>
      mounted.current &&
      latest.current.canFetch &&
      latest.current.api === start.api &&
      latest.current.account === start.account &&
      latest.current.channelId === start.channelId;
    try {
      const confirmed = await confirmAlert({
        title: "ブックマークを削除しますか？",
        message: deleteBookmarkConfirmation(channel.name, bookmark),
        primaryAction: {
          title: "Delete Bookmark",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!confirmed || !isCurrent()) return;
      let refreshed = false;
      const outcome = await write.run(async () => {
        const result = await completeBookmarkWrite(
          () => removeBookmark(start.api, start.channelId, bookmark, isCurrent),
          onWritten,
        );
        refreshed = result.refreshed;
        return result.outcome;
      });
      if (!outcome || !isCurrent()) return;
      await showToast({
        style:
          outcome.kind === "succeeded"
            ? Toast.Style.Success
            : Toast.Style.Failure,
        title:
          outcome.kind === "succeeded"
            ? refreshed
              ? "削除しました"
              : "削除済み・一覧更新は未完了"
            : outcome.kind === "unconfirmed"
              ? "削除できたか未確認です"
              : "削除できませんでした",
        message:
          outcome.kind === "succeeded"
            ? refreshed
              ? undefined
              : "一覧を再読込してください"
            : outcome.message,
      });
    } finally {
      deletionPending.current = false;
    }
  }
  const mayWrite =
    session.canFetch &&
    FEATURE_GATES.bookmarksWrite &&
    !write.busy &&
    !write.unconfirmed &&
    !uncertain;
  const common = (
    <>
      {mayWrite && (
        <Action.Push
          title="Add Bookmark"
          icon={Icon.Plus}
          target={
            <BookmarkForm
              session={session}
              channel={channel}
              onWritten={onWritten}
            />
          }
        />
      )}
      <Action
        title="Reload Bookmarks"
        icon={Icon.ArrowClockwise}
        onAction={async () => {
          await state.refresh();
        }}
      />
      <Action.Open
        title="Open Channel in Slack"
        target={slackAppChannelLink(session.display.teamId, channel.id)}
        application="Slack"
      />
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
  const status = uncertain
    ? "変更結果が未確認です。Slackで対象を確認してください"
    : (state.message ??
      (state.status === "loading"
        ? "取得中"
        : `${state.data.length}件 · このチャンネルのブックマーク`));
  return (
    <List
      navigationTitle={`#${channel.name}のブックマーク`}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="タイトルで絞り込む"
      filtering={false}
      isShowingDetail={details}
      isLoading={state.status === "loading" || write.busy}
    >
      <List.EmptyView
        title={
          state.status === "failed" || state.status === "auth-required"
            ? "ブックマークを取得できません"
            : state.status === "loading"
              ? "取得中"
              : uncertain
                ? "変更結果を確認してください"
                : query
                  ? "タイトルに一致するブックマークがありません"
                  : "ブックマークはありません"
        }
        description={status}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      <List.Section title={`#${channel.name}`} subtitle={status}>
        {rows.map((bookmark) => {
          const url = bookmarkUrl(bookmark.link ?? "");
          return (
            <List.Item
              key={bookmark.id}
              title={bookmark.title || "（タイトルなし）"}
              icon={Icon.Link}
              subtitle={details ? undefined : bookmark.link}
              accessories={
                bookmark.type === "link" ? undefined : [{ tag: "閲覧のみ" }]
              }
              detail={
                <List.Item.Detail
                  markdown={`## ${escapeDetail(bookmark.title)}\n\n**チャンネル**: ${escapeDetail(channel.name)}\n\n**URL**: ${escapeDetail(bookmark.link ?? "（URLなし）")}\n\n**種別**: ${escapeDetail(bookmark.type)}\n\n**ID**: ${escapeDetail(bookmark.id)}${url ? "" : "\n\nHTTP(S)のURLを確認できないため、このリンクは開けません。"}`}
                />
              }
              actions={
                <ActionPanel>
                  {url ? (
                    <Action.Open title="Open Link" target={url} />
                  ) : (
                    <Action
                      title="Link Unavailable"
                      icon={Icon.Warning}
                      onAction={() =>
                        showToast({
                          style: Toast.Style.Failure,
                          title: "HTTP(S)のURLを確認できません",
                        })
                      }
                    />
                  )}
                  <Action
                    title={details ? "Hide Details" : "Show Details"}
                    icon={Icon.Sidebar}
                    shortcut={DETAILS_SHORTCUT}
                    onAction={() => setDetails((value) => !value)}
                  />
                  {mayWrite && bookmark.type === "link" && (
                    <>
                      <Action.Push
                        title="Edit Bookmark"
                        icon={Icon.Pencil}
                        target={
                          <BookmarkForm
                            session={session}
                            channel={channel}
                            bookmark={bookmark}
                            onWritten={onWritten}
                          />
                        }
                      />
                      <Action
                        title="Delete Bookmark"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        onAction={() => remove(bookmark)}
                      />
                    </>
                  )}
                  {common}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
