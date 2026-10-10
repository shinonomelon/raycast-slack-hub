import {
  Action,
  ActionPanel,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { slackAppChannelLink } from "../compose/compose.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { useWriteOperation } from "../operations/use-write-operation.ts";
import type { WriteOutcome } from "../operations/write-outcome.ts";
import { addBookmark, editBookmark } from "./bookmarks-api.ts";
import { completeBookmarkWrite } from "./bookmarks-write.ts";
import {
  bookmarkInput,
  bookmarkUrl,
  type Bookmark,
} from "./bookmarks-model.ts";

type Props = {
  session: Session;
  channel: { id: string; name: string };
  bookmark?: Bookmark;
  onWritten: (outcome: WriteOutcome) => Promise<boolean>;
};
export function BookmarkForm(props: Props) {
  if (!FEATURE_GATES.bookmarksWrite)
    return <ApiGateNotice title="ブックマークの書き込み" />;
  return <EditableBookmarkForm {...props} />;
}
function EditableBookmarkForm({
  session,
  channel,
  bookmark,
  onWritten,
}: Props) {
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [link, setLink] = useState(bookmark?.link ?? "");
  const [titleError, setTitleError] = useState<string>();
  const [linkError, setLinkError] = useState<string>();
  const frozen = useRef({
    api: session.api,
    account: scopeKey(session.display),
    channel: { ...channel },
    bookmark,
  });
  const current =
    frozen.current.api === session.api &&
    frozen.current.account === scopeKey(session.display) &&
    frozen.current.channel.id === channel.id;
  const active = useRef(current && session.canFetch);
  active.current = current && session.canFetch;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const write = useWriteOperation(session);
  const { pop } = useNavigation();
  async function save() {
    if (!active.current || write.busy || write.unconfirmed) return;
    setTitleError(title.trim() ? undefined : "タイトルを入力してください");
    setLinkError(
      bookmarkUrl(link) ? undefined : "HTTP(S)のURLを入力してください",
    );
    const input = bookmarkInput({ title, link });
    if (!input) return;
    const target = frozen.current;
    const isCurrent = () => mounted.current && active.current;
    let refreshed = false;
    const outcome = await write.run(async () => {
      const result = await completeBookmarkWrite(
        () =>
          target.bookmark
            ? editBookmark(
                target.api,
                target.channel.id,
                target.bookmark,
                input,
                isCurrent,
              )
            : addBookmark(target.api, target.channel.id, input, isCurrent),
        onWritten,
      );
      refreshed = result.refreshed;
      return result.outcome;
    });
    if (!outcome || !isCurrent()) return;
    if (outcome.kind === "failed") {
      await showToast({
        style: Toast.Style.Failure,
        title: "保存できませんでした",
        message: outcome.message,
      });
      return;
    }
    if (outcome.kind === "unconfirmed") {
      await showToast({
        style: Toast.Style.Failure,
        title: "保存できたか未確認です",
        message:
          "Slackでチャンネルを確認してください。このフォームからは再送しません。",
      });
      return;
    }
    await showToast({
      style: Toast.Style.Success,
      title: refreshed ? "保存しました" : "保存済み・一覧更新は未完了",
      message: refreshed
        ? undefined
        : "一覧を再読込してください。保存操作を繰り返す必要はありません。",
    });
    pop();
  }
  return (
    <Form
      navigationTitle={bookmark ? "ブックマークを編集" : "ブックマークを追加"}
      isLoading={write.busy}
      actions={
        <ActionPanel>
          {write.unconfirmed || write.outcome?.kind === "succeeded" ? (
            <Action.Open
              title="Check Channel in Slack"
              target={slackAppChannelLink(
                session.display.teamId,
                frozen.current.channel.id,
              )}
              application="Slack"
            />
          ) : (
            active.current &&
            !write.busy && (
              <Action.SubmitForm
                title="Save Bookmark"
                icon={Icon.Checkmark}
                onSubmit={save}
              />
            )
          )}
        </ActionPanel>
      }
    >
      <Form.Description
        title="チャンネル"
        text={`#${frozen.current.channel.name}`}
      />
      {(!current || !session.canFetch) && (
        <Form.Description
          title="認証"
          text="認証または対象が変わりました。戻ってフォームを開き直してください。"
        />
      )}
      {write.unconfirmed && (
        <Form.Description
          title="保存結果"
          text="保存できたか未確認です。Slackで対象を確認してから、必要ならフォームを開き直してください。"
        />
      )}
      <Form.TextField
        id="title"
        title="タイトル"
        value={title}
        error={titleError}
        onChange={(value) => {
          setTitle(value);
          setTitleError(undefined);
        }}
        autoFocus
      />
      <Form.TextField
        id="link"
        title="URL"
        placeholder="https://…"
        value={link}
        error={linkError}
        onChange={(value) => {
          setLink(value);
          setLinkError(undefined);
        }}
      />
    </Form>
  );
}
