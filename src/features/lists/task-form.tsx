import {
  Action,
  ActionPanel,
  Form,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import type { MembershipContext } from "../membership/membership-context.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import type { WriteOutcome } from "../operations/write-outcome.ts";
import { useWriteOperation } from "../operations/use-write-operation.ts";
import { taskCapabilities } from "./task-capabilities.ts";
import { createTaskFormSubmission } from "./task-form-submission.ts";
import { editableTitle, writeTask } from "./task-write.ts";
import { validDate, type SlackList, type TaskItem } from "./lists-model.ts";
export function TaskForm({
  context,
  list,
  item,
  source,
  initialTitle = "",
  onSaved,
}: {
  context: MembershipContext;
  list: SlackList;
  item?: TaskItem;
  source?: string;
  initialTitle?: string;
  onSaved?: (outcome: WriteOutcome) => unknown;
}) {
  if (!FEATURE_GATES.listsWrite) return <ApiGateNotice title="Task Editing" />;
  return (
    <EditableTaskForm
      context={context}
      list={list}
      item={item}
      source={source}
      initialTitle={initialTitle}
      onSaved={onSaved}
    />
  );
}
function EditableTaskForm({
  context,
  list,
  item,
  source,
  initialTitle,
  onSaved,
}: {
  context: MembershipContext;
  list: SlackList;
  item?: TaskItem;
  source?: string;
  initialTitle: string;
  onSaved?: (outcome: WriteOutcome) => unknown;
}) {
  const owner = useRef({
    api: context.session.api,
    team: context.session.display.teamId,
    user: context.session.display.userId,
    list,
    item,
  });
  const [title, setTitle] = useState(
    item ? (editableTitle(item.richText) ?? "") : initialTitle,
  );
  const [assignees, setAssignees] = useState(item?.assigneeIds ?? []);
  const [due, setDue] = useState(item?.dueDate ?? "");
  const [completed, setCompleted] = useState(item?.completed ?? false);
  const [error, setError] = useState<string>();
  const operation = useWriteOperation(context.session);
  const submission = useRef(createTaskFormSubmission());
  const mounted = useRef(true);
  const [, redraw] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { pop } = useNavigation();
  const capabilities = taskCapabilities(list);
  const current = useRef({
    api: context.session.api,
    team: context.session.display.teamId,
    user: context.session.display.userId,
    canFetch: context.session.canFetch,
    listId: list.id,
    itemId: item?.id,
  });
  current.current = {
    api: context.session.api,
    team: context.session.display.teamId,
    user: context.session.display.userId,
    canFetch: context.session.canFetch,
    listId: list.id,
    itemId: item?.id,
  };
  const sameTarget = () =>
    current.current.api === owner.current.api &&
    current.current.team === owner.current.team &&
    current.current.user === owner.current.user &&
    current.current.canFetch &&
    current.current.listId === owner.current.list.id &&
    current.current.itemId === owner.current.item?.id;
  // 直前検証中にフォームが閉じられたら書込を始めない。開始後の親通知はmountと分離する。
  const isCurrent = () => mounted.current && sameTarget();
  const matching =
    owner.current.api === context.session.api &&
    owner.current.team === context.session.display.teamId &&
    owner.current.user === context.session.display.userId &&
    owner.current.list.id === list.id &&
    owner.current.item?.id === item?.id;
  const editable =
    matching &&
    context.session.canFetch &&
    list.editable &&
    capabilities.primary &&
    !item?.archived &&
    (!item || editableTitle(item.richText) !== undefined);
  const send = async () => {
    if (
      !editable ||
      operation.busy ||
      operation.unconfirmed ||
      !submission.current.canSubmit
    )
      return;
    if (!title.trim()) {
      setError("タイトルを入力してください");
      return;
    }
    if (due && !validDate(due)) {
      setError("期限はYYYY-MM-DD形式の日付で入力してください");
      return;
    }
    if (!submission.current.begin()) return;
    const outcome = await operation.run(async () => {
      const saved = await writeTask({
        session: context.session,
        isCurrent,
        allowClearing: FEATURE_GATES.listsClearValues,
        list: owner.current.list,
        item: owner.current.item,
        source,
        kind: item ? "update" : "create",
        values: {
          title: title.trim(),
          ...(capabilities.assignee && (!item || item.assigneeIds !== undefined)
            ? { assigneeIds: assignees }
            : {}),
          ...(capabilities.due && (!item || item.dueDate !== undefined)
            ? { dueDate: due || null }
            : {}),
          ...(capabilities.completed && (!item || item.completed !== undefined)
            ? { completed }
            : {}),
        },
      });
      // 成功応答を受けた瞬間に同期ラッチを閉じ、親の再取得やtoastを待つ間も再送しない。
      submission.current.accept(saved);
      if (mounted.current) redraw((value) => value + 1);
      // 子Formを閉じた後も、親の同一対象だけ失効させる。hookのmounted判定の前に通知する。
      if (saved.kind !== "failed" && sameTarget()) {
        try {
          await onSaved?.(saved);
        } catch {
          await showToast({
            style:
              saved.kind === "succeeded"
                ? Toast.Style.Success
                : Toast.Style.Failure,
            title:
              saved.kind === "succeeded"
                ? "保存済み・一覧更新は未完了"
                : "変更結果は未確認・一覧更新は未完了",
            message: saved.kind === "succeeded" ? saved.id : saved.message,
          });
        }
      }
      return saved;
    });
    if (!outcome) {
      submission.current.releaseUnstarted();
      return;
    }
    submission.current.accept(outcome);
    if (outcome.kind === "succeeded") {
      if (!mounted.current || !sameTarget()) return;
      await showToast({
        style: Toast.Style.Success,
        title: item ? "タスクを保存しました" : "タスクを作成しました",
        message: `ID: ${outcome.id ?? item?.id ?? "確認済み"}。親のフィルターにより表示されない場合があります。`,
      });
      if (mounted.current && sameTarget()) pop();
    }
  };
  return (
    <Form
      navigationTitle={item ? "タスクを編集" : "タスクを追加"}
      isLoading={operation.busy}
      actions={
        <ActionPanel>
          {operation.unconfirmed ||
          submission.current.unconfirmed ||
          submission.current.succeeded ||
          !editable ? (
            <Action.Open title="Open List to Verify" target={list.url} />
          ) : (
            <Action.SubmitForm
              title={item ? "Save Task" : "Create Task"}
              onSubmit={send}
            />
          )}
          <Action.Open title="Open List in Slack" target={list.url} />
        </ActionPanel>
      }
    >
      <Form.Description title="保存先" text={`${list.title} (${list.id})`} />
      {!editable && (
        <Form.Description
          title="編集できません"
          text="認証・権限・列構成・タイトルの書式を確認し、一覧を再読込してください。"
        />
      )}
      {operation.unconfirmed && (
        <Form.Description
          title="変更結果は未確認"
          text="Slackで保存先を確認してください。このフォームでは再送しません。"
        />
      )}
      {operation.outcome && operation.outcome.kind !== "succeeded" && (
        <Form.Description title="結果" text={operation.outcome.message} />
      )}
      {source && (
        <Form.Description
          title="元メッセージ"
          text={`${source}\n保存先: ${capabilities.message ? "message列" : "タイトルの末尾に元メッセージリンク"}`}
        />
      )}
      <Form.TextField
        id="title"
        title="タイトル"
        value={title}
        onChange={(text) => {
          setTitle(text);
          setError(undefined);
        }}
        error={error}
        autoFocus
      />
      {capabilities.assignee && (!item || item.assigneeIds !== undefined) && (
        <Form.TagPicker
          id="assignees"
          title="担当者"
          value={assignees}
          onChange={(values) => {
            if (
              item?.assigneeIds?.length &&
              !values.length &&
              !FEATURE_GATES.listsClearValues
            ) {
              setError("担当のクリア形式は実APIで未検証です");
              return;
            }
            setAssignees(values);
          }}
        >
          {Array.from(
            new Set([...assignees, ...context.people.map((p) => p.id)]),
          ).map((id) => (
            <Form.TagPicker.Item
              key={id}
              value={id}
              title={context.names.lookup.user(id) ?? id}
            />
          ))}
        </Form.TagPicker>
      )}
      {capabilities.due && (!item || item.dueDate !== undefined) && (
        <Form.TextField
          id="due"
          title="期限"
          placeholder="YYYY-MM-DD（日付のみ）"
          value={due}
          onChange={(value) => {
            if (item?.dueDate && !value && !FEATURE_GATES.listsClearValues) {
              setError("期限のクリア形式は実APIで未検証です");
              return;
            }
            setDue(value);
          }}
        />
      )}
      {capabilities.completed && (!item || item.completed !== undefined) && (
        <Form.Checkbox
          id="completed"
          title="状態"
          label="完了"
          value={completed}
          onChange={setCompleted}
        />
      )}
      {item && (
        <Form.Description text="更新直前に項目の変更を確認しますが、検査直後の他者編集との競合を完全には防げません。" />
      )}
    </Form>
  );
}
