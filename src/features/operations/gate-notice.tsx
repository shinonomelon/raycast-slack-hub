import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  openExtensionPreferences,
} from "@raycast/api";

export function ApiGateNotice({ title }: { title: string }) {
  return (
    <Detail
      navigationTitle={title}
      markdown={`## ${title}\n\nこの機能は実APIでの検証が完了するまで利用できません。検証後に有効化します。\n\n既存の検索・投稿は引き続き利用できます。`}
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
  );
}
