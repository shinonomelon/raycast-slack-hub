import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  List,
  confirmAlert,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import type { Conversation } from "../../shared/types.ts";
import type { ChannelLibrary, LibraryMutation } from "./model.ts";

export type LibraryMutator = (
  mutation: LibraryMutation,
) => Promise<ChannelLibrary | false>;
type Props = {
  library: ChannelLibrary;
  conversations: readonly Conversation[];
  onMutate: LibraryMutator;
};
function MutationForm({
  title,
  initialName,
  initialIds,
  conversations,
  onSave,
}: {
  title: string;
  initialName?: string;
  initialIds?: string[];
  conversations?: readonly Conversation[];
  onSave: (name: string, ids: string[]) => Promise<boolean>;
}) {
  const { pop } = useNavigation();
  const [name, setName] = useState(initialName ?? "");
  const [ids, setIds] = useState(initialIds ?? []);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    if (!conversations && !name.trim()) {
      setError("名前を入力してください");
      return;
    }
    setSaving(true);
    try {
      if (await onSave(name.trim(), ids)) pop();
      else
        setError(
          "保存できませんでした。名前の重複や整理ファイルの状態を確認してください",
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存できませんでした");
    } finally {
      setSaving(false);
    }
  };
  const known = new Set(
    conversations?.filter((c) => c.type !== "mpim").map((c) => c.id),
  );
  return (
    <Form
      navigationTitle={title}
      isLoading={saving}
      actions={
        <ActionPanel>
          <Action title="保存" onAction={save} />
        </ActionPanel>
      }
    >
      {conversations ? (
        <Form.TagPicker
          id="channels"
          title="所属チャンネル"
          value={ids}
          onChange={setIds}
          error={error}
        >
          {[...conversations]
            .filter((c) => c.type !== "mpim")
            .sort((a, b) => a.name.localeCompare(b.name, "ja"))
            .map((c) => (
              <Form.TagPicker.Item
                key={c.id}
                value={c.id}
                title={`#${c.name}`}
              />
            ))}
          {initialIds
            ?.filter((id) => !known.has(id))
            .map((id) => (
              <Form.TagPicker.Item
                key={id}
                value={id}
                title={`${id}（現在参照できません）`}
              />
            ))}
        </Form.TagPicker>
      ) : (
        <Form.TextField
          id="name"
          title="セクション名"
          value={name}
          onChange={setName}
          error={error}
        />
      )}
      <Form.Description text="保存するまで変更は反映されません。お気に入りとセクション所属は独立しています。" />
    </Form>
  );
}
export function SectionScreen({
  library: initial,
  conversations,
  onMutate,
}: Props) {
  const { push } = useNavigation();
  const [library, setLibrary] = useState(initial);
  const [error, setError] = useState<string>();
  const mutate = async (mutation: LibraryMutation) => {
    const result = await onMutate(mutation);
    if (result) {
      setLibrary(result);
      setError(undefined);
      return true;
    }
    setError("整理データを保存できませんでした");
    return false;
  };
  const create = (
    <Action
      title="セクションを作成"
      icon={Icon.Plus}
      onAction={() =>
        push(
          <MutationForm
            title="セクションを作成"
            onSave={(name) => mutate({ kind: "create-section", name })}
          />,
        )
      }
    />
  );
  return (
    <List
      navigationTitle="セクションを管理"
      searchBarPlaceholder="セクションを探す"
      actions={<ActionPanel>{create}</ActionPanel>}
    >
      {error && (
        <List.Item
          title={error}
          icon={Icon.Warning}
          actions={<ActionPanel>{create}</ActionPanel>}
        />
      )}
      {[...library.sections]
        .sort((a, b) => a.name.localeCompare(b.name, "ja"))
        .map((section) => (
          <List.Item
            key={section.id}
            title={section.name}
            subtitle={`${section.channelIds.length}チャンネル`}
            icon={Icon.Folder}
            actions={
              <ActionPanel>
                <Action
                  title="所属チャンネルを編集"
                  onAction={() =>
                    push(
                      <MutationForm
                        title={`${section.name}の所属`}
                        initialIds={section.channelIds}
                        conversations={conversations}
                        onSave={(_, channelIds) =>
                          mutate({
                            kind: "set-section-channels",
                            sectionId: section.id,
                            channelIds,
                          })
                        }
                      />,
                    )
                  }
                />
                <Action
                  title="名前を変更"
                  onAction={() =>
                    push(
                      <MutationForm
                        title="名前を変更"
                        initialName={section.name}
                        onSave={(name) =>
                          mutate({
                            kind: "rename-section",
                            sectionId: section.id,
                            name,
                          })
                        }
                      />,
                    )
                  }
                />
                {create}
                <Action
                  title="セクションを削除"
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    if (
                      await confirmAlert({
                        title: `「${section.name}」を削除しますか？`,
                        message: "このセクションの所属設定を削除します。",
                        primaryAction: {
                          title: "削除",
                          style: Alert.ActionStyle.Destructive,
                        },
                      })
                    )
                      await mutate({
                        kind: "delete-section",
                        sectionId: section.id,
                      });
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      <List.EmptyView
        title="セクションがありません"
        description="Actionsからセクションを作成できます"
        actions={<ActionPanel>{create}</ActionPanel>}
      />
    </List>
  );
}
export function SectionMembershipForm({
  library,
  channelId,
  channelName,
  onMutate,
}: {
  library: ChannelLibrary;
  channelId: string;
  channelName: string;
  onMutate: LibraryMutator;
}) {
  const { pop } = useNavigation();
  const [sectionIds, setSectionIds] = useState(
    library.sections
      .filter((s) => s.channelIds.includes(channelId))
      .map((s) => s.id),
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <Form
      navigationTitle={`#${channelName}の所属`}
      isLoading={saving}
      actions={
        <ActionPanel>
          <Action
            title="保存"
            onAction={async () => {
              if (saving) return;
              setSaving(true);
              try {
                if (
                  await onMutate({
                    kind: "set-channel-sections",
                    channelId,
                    sectionIds,
                  })
                )
                  pop();
                else setError("保存できませんでした。再試行してください");
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "保存できませんでした",
                );
              } finally {
                setSaving(false);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TagPicker
        id="sections"
        title="所属セクション"
        value={sectionIds}
        onChange={setSectionIds}
        error={error}
      >
        {[...library.sections]
          .sort((a, b) => a.name.localeCompare(b.name, "ja"))
          .map((s) => (
            <Form.TagPicker.Item key={s.id} value={s.id} title={s.name} />
          ))}
      </Form.TagPicker>
      <Form.Description text="複数のセクションへ所属できます。お気に入りを外しても所属は変わりません。" />
    </Form>
  );
}
