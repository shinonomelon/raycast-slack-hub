import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { useState } from "react";
import type { MembershipContext } from "../membership/membership-context.ts";
import type { ItemFilter } from "./lists-model.ts";
import type { TaskCapabilities } from "./task-capabilities.ts";
export function ItemFilterForm({
  context,
  filter,
  capabilities,
  onApply,
}: {
  context: MembershipContext;
  filter: ItemFilter;
  capabilities: TaskCapabilities;
  onApply: (filter: ItemFilter) => void;
}) {
  const [assignee, setAssignee] = useState(filter.assignee);
  const [status, setStatus] = useState(filter.status);
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="項目を絞り込む"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Filters"
            onSubmit={() => {
              onApply({
                assignee: capabilities.assignee ? assignee : "",
                status: capabilities.completed ? status : "all",
              });
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="読み込み済み項目だけを絞り込みます。Load Moreで検索対象を追加できます。" />
      {capabilities.assignee && (
        <Form.Dropdown
          id="assignee"
          title="担当者"
          value={assignee}
          onChange={setAssignee}
        >
          <Form.Dropdown.Item value="" title="すべて" />
          <Form.Dropdown.Item
            value={context.session.display.userId}
            title="自分"
          />
          {context.people
            .filter((person) => person.id !== context.session.display.userId)
            .map((person) => (
              <Form.Dropdown.Item
                key={person.id}
                value={person.id}
                title={person.displayName || person.realName || person.handle}
              />
            ))}
        </Form.Dropdown>
      )}
      {capabilities.completed && (
        <Form.Dropdown
          id="status"
          title="状態"
          value={status}
          onChange={(value) => setStatus(value as ItemFilter["status"])}
        >
          <Form.Dropdown.Item value="all" title="すべて" />
          <Form.Dropdown.Item value="incomplete" title="未完了" />
          <Form.Dropdown.Item value="complete" title="完了" />
        </Form.Dropdown>
      )}
    </Form>
  );
}
