import { Action, ActionPanel, Detail } from "@raycast/api";
import { useEffect, useState } from "react";
import type { ApiCall } from "../../slack/slack-api.ts";
import type { Hit } from "../../slack/hits.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { fetchItems } from "./lists-api.ts";
import { escapeMarkdown, type SlackList } from "./lists-model.ts";
import { taskCapabilities } from "./task-capabilities.ts";
import { messageTaskSource, taskTitleFromMessage } from "./message-task.ts";
import { TaskForm } from "./task-form.tsx";
export function TaskPreparation({
  context,
  listId,
  hit,
}: {
  context: MembershipContext;
  listId: string;
  hit: Hit;
}) {
  const [savedResult, setResult] = useState<{
    api: ApiCall;
    stamp: string;
    list?: SlackList;
    source?: string;
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  const stamp = `${context.session.display.teamId}:${context.session.display.userId}:${context.session.canFetch}:${listId}:${hit.key}:${retry}`;
  const result =
    savedResult?.api === context.session.api && savedResult.stamp === stamp
      ? savedResult
      : undefined;
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    setResult(undefined);
    if (
      context.session.canFetch &&
      FEATURE_GATES.listsRead &&
      FEATURE_GATES.listsWrite
    ) {
      void (async () => {
        let list: SlackList | undefined;
        try {
          const page = await fetchItems(
            context.session.api,
            context.session.display.teamId,
            listId,
            { limit: 1, signal: abort.signal },
          );
          if (!alive) return;
          list = page.list;
          const source = await messageTaskSource(context.session.api, hit);
          if (alive)
            setResult({
              api: context.session.api,
              stamp,
              list: page.list,
              source,
            });
        } catch (error) {
          if (alive)
            setResult({
              api: context.session.api,
              stamp,
              list,
              error:
                error instanceof Error
                  ? error.message
                  : "保存先を確認できませんでした",
            });
        }
      })();
    }
    return () => {
      alive = false;
      abort.abort();
    };
  }, [
    context.session.api,
    context.session.canFetch,
    context.session.display.teamId,
    listId,
    hit,
    retry,
    stamp,
  ]);
  if (!FEATURE_GATES.listsRead || !FEATURE_GATES.listsWrite)
    return <ApiGateNotice title="Create Task from Message" />;
  if (!context.session.canFetch)
    return <Detail markdown="認証を確認してHubを開き直してください。" />;
  const capabilities = result?.list ? taskCapabilities(result.list) : undefined;
  if (
    result?.list &&
    result.source &&
    result.list.editable &&
    capabilities?.primary
  )
    return (
      <TaskForm
        context={context}
        list={result.list}
        source={result.source}
        initialTitle={taskTitleFromMessage(hit)}
      />
    );
  return (
    <Detail
      isLoading={!result}
      markdown={
        result?.error
          ? escapeMarkdown(result.error)
          : result?.list
            ? `このリストは対応するタイトル列または編集権限を確認できません。\n\n${capabilities?.reasons.map(escapeMarkdown).join("\n\n")}`
            : "保存先と元メッセージURLを確認しています。"
      }
      actions={
        <ActionPanel>
          {result?.list && (
            <Action.Open title="Open List in Slack" target={result.list.url} />
          )}
          {result?.list?.editable && capabilities?.primary && (
            <Action.Push
              title="Add Task Without Source"
              target={<TaskForm context={context} list={result.list} />}
            />
          )}
          <Action
            title="Refresh"
            onAction={() => setRetry((value) => value + 1)}
          />
        </ActionPanel>
      }
    />
  );
}
