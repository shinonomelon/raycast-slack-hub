import { t } from "../../shared/i18n.ts";
import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { normalize, type DictionaryRule } from "../search/search.ts";
function AddRule({ onSubmit }: { onSubmit: (rule: DictionaryRule) => void }) {
  const { pop } = useNavigation();
  const [fromError, setFromError] = useState<string>();
  return (
    <Form
      navigationTitle={t("置き換えを追加")}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={t("Add")}
            onSubmit={(values: { from: string; to: string }) => {
              if (!values.from.trim()) {
                setFromError(t("置き換える語を入れてください"));
                return;
              }
              onSubmit({ from: values.from.trim(), to: values.to.trim() });
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="from"
        title={t("チャンネル名の語")}
        placeholder={t("ドキュメント")}
        error={fromError}
        onChange={() => setFromError(undefined)}
      />
      <Form.TextField id="to" title={t("自分の呼び方")} placeholder="docs" />
      <Form.Description
        text={t(
          "チャンネル名やグループDMの名前に含まれる語を置き換えた名前でも、検索に当たるようになります。例: ドキュメント \u2192 docsで、docsからドキュメントの名前を探せます",
        )}
      />
    </Form>
  );
}
// 名前の置き換え辞書の一覧。規則ごとに、当たるチャンネルの数を出す
export function Dictionary({
  rules: initialRules,
  names,
  onChange,
}: {
  rules: readonly DictionaryRule[];
  names: readonly string[];
  onChange: (rules: DictionaryRule[]) => void;
}) {
  // 押し出された画面は親の再描画を受けないので、自分でも規則を持つ
  const [rules, setRules] = useState<DictionaryRule[]>([...initialRules]);
  const normalizedNames = names.map(normalize);
  const update = (next: DictionaryRule[]) => {
    setRules(next);
    onChange(next);
  };
  const addAction = (
    <Action.Push
      title={t("Add Rule")}
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<AddRule onSubmit={(rule) => update([...rules, rule])} />}
    />
  );
  return (
    <List navigationTitle={t("名前の置き換え辞書")}>
      <List.EmptyView
        title={t("置き換えはまだありません")}
        description={t(
          "ActionsのAdd Ruleで追加します（例: ドキュメント \u2192 docs）",
        )}
        actions={<ActionPanel>{addAction}</ActionPanel>}
      />
      {rules.map((rule, index) => {
        const from = normalize(rule.from);
        const hits = normalizedNames.filter((n) => n.includes(from)).length;
        return (
          <List.Item
            key={`${rule.from}-${index}`}
            title={`${rule.from} → ${rule.to}`}
            accessories={[{ text: t("{0} 件", hits) }]}
            actions={
              <ActionPanel>
                {addAction}
                <Action
                  title={t("Delete Rule")}
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => {
                    const ok = await confirmAlert({
                      title: t(
                        "{0} \u2192 {1} を消しますか",
                        rule.from,
                        rule.to,
                      ),
                      primaryAction: {
                        title: t("Delete"),
                        style: Alert.ActionStyle.Destructive,
                      },
                    });
                    if (ok) update(rules.filter((_, i) => i !== index));
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
