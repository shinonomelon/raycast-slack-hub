import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  environment,
  Icon,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { useMemo, useState } from "react";
import { PEOPLE, useDirectory } from "./directory.ts";
import {
  createDraftStore,
  recordDestination,
  recordLink,
  recordTitle,
  withMentionNames,
  type DraftRecord,
} from "./draft-records.ts";
import {
  scopeKey,
  sessionOf,
  type IdentityFailure,
  type Session,
} from "./identity.ts";
import { useIdentity } from "./use-identity.ts";

// Slack Drafts：Slack Hub のフォームで保存した下書きの控えを、新しい順に見るコマンド（2026年10月8日）。
// Slack 側の下書きは Hub から読めないので、出すのは Hub が作ったときの控え。Slack で送った・消した下書きも、
// 30日たつか、ここで消すまで残る。控えを消しても、Slack 側の下書きは消えない

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const FAILURE_ICON = { source: Icon.ExclamationMark, tintColor: Color.Red };

// 控えはワークスペースと自分の ID ごとに出し分けるので、まず whoami で自分の情報を取る。
// 前回の結果があれば、その人の控えをすぐ出す（Slack Hub と同じ扱い）
export default function Command() {
  const { decision, failure, checking } = useIdentity();
  const session = useMemo(() => sessionOf(decision), [decision]);
  if (!session) {
    return <NoIdentity failure={failure} checking={checking} />;
  }
  return <Drafts key={scopeKey(session.display)} session={session} />;
}

function NoIdentity({
  failure,
  checking,
}: {
  failure: IdentityFailure | undefined;
  checking: boolean;
}) {
  return (
    <List isLoading={checking}>
      {failure ? (
        <List.EmptyView
          icon={FAILURE_ICON}
          title={failure.title}
          description={failure.message}
          actions={
            <ActionPanel>
              <Action
                title="Open Extension Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView title="Slack に自分の情報を問い合わせています" />
      )}
    </List>
  );
}

// 読み込みの結果。読めなかったときは理由を出す（ファイルは上書きしない）
type Loaded = { records: DraftRecord[]; error?: string };

function Drafts({ session }: { session: Session }) {
  const who = session.display;
  const store = useMemo(() => createDraftStore(environment.supportPath), []);
  // 開いたときに同期で読む。期限切れの控えはここで消える
  const load = (): Loaded => {
    try {
      return { records: store.load(who) };
    } catch (error) {
      return { records: [], error: errorMessage(error) };
    }
  };
  const [loaded, setLoaded] = useState<Loaded>(load);
  // ↵ で本文の全文を右に出す・隠す
  const [showingDetail, setShowingDetail] = useState(false);

  // メンションを名前で出すための人の一覧（Slack Hub と同じキャッシュ）
  const people = useDirectory(PEOPLE, session);
  const names = useMemo(
    () =>
      new Map(
        (people.data ?? []).map((p) => [p.id, p.displayName || p.handle]),
      ),
    [people.data],
  );

  async function remove(record: DraftRecord) {
    const confirmed = await confirmAlert({
      title: "この控えを消しますか？",
      message:
        "消えるのは Slack Drafts の控えだけです。Slack 側の下書きは残るので、要らなければ Slack の Drafts & sent から消してください",
      primaryAction: {
        title: "Delete Record",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;
    try {
      store.remove(record.draftId, who);
      setLoaded(load());
      await showToast({
        style: Toast.Style.Success,
        title: "控えを消しました",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "控えを消せませんでした",
        message: errorMessage(error),
      });
    }
  }

  const { records, error } = loaded;
  return (
    <List
      isShowingDetail={showingDetail && records.length > 0}
      searchBarPlaceholder="控えを絞り込む"
    >
      {records.length === 0 ? (
        error ? (
          <List.EmptyView
            icon={FAILURE_ICON}
            title="控えを読めませんでした"
            description={error}
          />
        ) : (
          <List.EmptyView
            icon={Icon.Document}
            title="下書きの控えはありません"
            description="Slack Hub のフォームで ⌘S を押すと、Slack の下書きに保存して、ここに控えを残します。Slack 側の下書き（Drafts & sent）は Hub からは見られません"
          />
        )
      ) : null}
      {records.map((record) => {
        const created = new Date(record.createdAt);
        return (
          <List.Item
            key={record.draftId}
            icon={record.threadTs ? Icon.Bubble : Icon.Document}
            title={withMentionNames(recordTitle(record), names)}
            subtitle={showingDetail ? undefined : recordDestination(record)}
            keywords={[record.destination]}
            accessories={[
              { date: created, tooltip: created.toLocaleString("ja-JP") },
            ]}
            detail={
              <List.Item.Detail
                markdown={withMentionNames(record.markdown, names)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="宛先"
                      text={recordDestination(record)}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="保存した時刻"
                      text={created.toLocaleString("ja-JP")}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="draft_id"
                      text={record.draftId}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title={showingDetail ? "Hide Full Text" : "Show Full Text"}
                  icon={Icon.Sidebar}
                  onAction={() => setShowingDetail((value) => !value)}
                />
                <Action.Open
                  title="Open in Slack"
                  icon={Icon.ArrowNe}
                  target={recordLink(record)}
                  application="Slack"
                />
                <Action
                  title="Delete Record"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                  onAction={() => remove(record)}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
