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
import { normalize, type DictionaryRule } from "./search.ts";

function AddRule({ onSubmit }: { onSubmit: (rule: DictionaryRule) => void }) {
  const { pop } = useNavigation();
  const [fromError, setFromError] = useState<string>();
  return (
    <Form
      navigationTitle="置き換えを追加"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Add"
            onSubmit={(values: { from: string; to: string }) => {
              if (!values.from.trim()) {
                setFromError("置き換える語を入れてください");
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
        title="チャンネル名の語"
        placeholder="自動取得"
        error={fromError}
        onChange={() => setFromError(undefined)}
      />
      <Form.TextField id="to" title="自分の呼び方" placeholder="auto" />
      <Form.Description text="チャンネル名やグループDMの名前に含まれる語を置き換えた名前でも、検索に当たるようになります。例: 自動取得 → auto で、op_auto から op_自動取得課_オペレーター が出ます" />
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
      title="Add Rule"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<AddRule onSubmit={(rule) => update([...rules, rule])} />}
    />
  );

  return (
    <List navigationTitle="名前の置き換え辞書">
      <List.EmptyView
        title="置き換えはまだありません"
        description="⌘N で追加します（例: 自動取得 → auto）"
        actions={<ActionPanel>{addAction}</ActionPanel>}
      />
      {rules.map((rule, index) => {
        const from = normalize(rule.from);
        const hits = normalizedNames.filter((n) => n.includes(from)).length;
        return (
          <List.Item
            key={`${rule.from}-${index}`}
            title={`${rule.from} → ${rule.to}`}
            accessories={[{ text: `${hits} 件` }]}
            actions={
              <ActionPanel>
                {addAction}
                <Action
                  title="Delete Rule"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => {
                    const ok = await confirmAlert({
                      title: `${rule.from} → ${rule.to} を消しますか`,
                      primaryAction: {
                        title: "Delete",
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
