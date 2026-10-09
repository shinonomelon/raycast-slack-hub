import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";

// 項目ごとの別名を編集するフォーム。カンマ（全角の読点も可）で区切って複数入れられる
export function EditAliases({
  title,
  aliases,
  onSubmit,
}: {
  title: string;
  aliases: readonly string[];
  onSubmit: (aliases: string[]) => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={`${title} の別名`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={(values: { aliases: string }) => {
              const next = [
                ...new Set(
                  values.aliases
                    .split(/[,、]/)
                    .map((a) => a.trim())
                    .filter(Boolean),
                ),
              ];
              onSubmit(next);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="aliases"
        title="別名"
        placeholder="分報, times"
        defaultValue={aliases.join(", ")}
        info="この名前でも検索に当たるようになります。空にすると別名を消します"
      />
    </Form>
  );
}
