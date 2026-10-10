import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { useState } from "react";
import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { listIdFromInput } from "./list-discovery.ts";
import { ListItemsScreen } from "./list-items-screen.tsx";
import { TaskPreparation } from "./task-preparation.tsx";
export function OpenListForm({
  context,
  hit,
}: {
  context: MembershipContext;
  hit?: Hit;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const { push } = useNavigation();
  if (!FEATURE_GATES.listsRead || (hit && !FEATURE_GATES.listsWrite))
    return <ApiGateNotice title="Open Slack List" />;
  const submit = () => {
    if (!context.session.canFetch) {
      setError("認証を確認しHubを開き直してください");
      return;
    }
    try {
      const listId = listIdFromInput(value, context.session.display.teamId);
      push(
        hit ? (
          <TaskPreparation context={context} listId={listId} hit={hit} />
        ) : (
          <ListItemsScreen context={context} listId={listId} />
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "URLを確認してください",
      );
    }
  };
  return (
    <Form
      navigationTitle="URL/IDでリストを開く"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="View Items" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="検索に表示されないリストも、アクセス権があれば開けます。入力URL自体には通信しません。" />
      <Form.TextField
        id="list"
        title="リストURL/ID"
        value={value}
        error={error}
        onChange={(text) => {
          setValue(text);
          setError(undefined);
        }}
        autoFocus
      />
    </Form>
  );
}
