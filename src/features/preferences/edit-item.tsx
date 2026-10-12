import { t } from "../../shared/i18n.ts";
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
      navigationTitle={t("{0} の別名", title)}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={t("Save")}
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
        title={t("別名")}
        placeholder={t("分報, times")}
        defaultValue={aliases.join(", ")}
        info={t(
          "この名前でも検索に当たるようになります。空にすると別名を消します",
        )}
      />
    </Form>
  );
}
