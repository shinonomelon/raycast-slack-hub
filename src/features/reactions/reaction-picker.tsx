import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useEffect, useRef } from "react";
import { messageLink, type Hit } from "../../slack/hits.ts";
import { scopeKey, type Session } from "../../slack/identity.ts";
import { ApiGateNotice } from "../operations/gate-notice.tsx";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { useWriteOperation } from "../operations/use-write-operation.ts";
import { fetchReactions, writeReaction } from "./reactions-api.ts";
import { myReactionNames, STANDARD_REACTIONS } from "./reactions-model.ts";
import { useReactions } from "./use-reactions.ts";

export function ReactionPicker(props: {
  session: Session;
  hit: Hit;
  mode: "add" | "remove";
}) {
  if (!FEATURE_GATES.reactionsRead || !FEATURE_GATES.reactionsWrite)
    return <ApiGateNotice title="Reactions" />;
  return (
    <ReactionPickerReady
      key={`${props.session.display.teamId}:${props.session.display.userId}:${props.hit.channelId}:${props.hit.ts}:${props.mode}`}
      {...props}
    />
  );
}
function ReactionPickerReady({
  session,
  hit,
  mode,
}: {
  session: Session;
  hit: Hit;
  mode: "add" | "remove";
}) {
  const read = useReactions(session, hit);
  const write = useWriteOperation(session);
  const identity = `${session.display.teamId}:${session.display.userId}:${hit.channelId}:${hit.ts}:${mode}`;
  const current = useRef({
    api: session.api,
    identity,
    canFetch: session.canFetch,
  });
  current.current = { api: session.api, identity, canFetch: session.canFetch };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mine = myReactionNames(read.reactions);
  const names =
    mode === "add" ? STANDARD_REACTIONS.map((reaction) => reaction.name) : mine;
  const choose = async (name: string) => {
    if (
      read.status !== "ready" ||
      !session.canFetch ||
      write.busy ||
      write.unconfirmed ||
      (mode === "remove" && !mine.includes(name))
    )
      return;
    const api = session.api;
    const fixedIdentity = identity;
    const account = scopeKey(session.fetchAs);
    const same = () =>
      mounted.current &&
      current.current.api === api &&
      current.current.identity === fixedIdentity &&
      current.current.canFetch;
    const outcome = await write.run(async () => {
      // 除去直前にも本人の反応を確認し、古い候補で書き込まない。
      if (mode === "remove") {
        try {
          const reactions = await fetchReactions(
            api,
            hit,
            session.fetchAs.userId,
          );
          if (!same() || account !== scopeKey(session.fetchAs))
            return {
              kind: "failed",
              message: "対象が変更されたため送信していません",
            };
          if (!myReactionNames(reactions).includes(name))
            return { kind: "succeeded" };
        } catch {
          return {
            kind: "failed",
            message: "本人の反応を確認できません。送信していません",
          };
        }
      }
      if (!same())
        return {
          kind: "failed",
          message: "対象が変更されたため送信していません",
        };
      return writeReaction(api, hit, name, mode);
    });
    if (!outcome || !same()) return;
    if (outcome.kind === "succeeded") {
      // 再読取を先に開始する。保存成功から候補更新までに古い候補を再実行させない。
      read.refresh();
    }
  };
  const status = write.unconfirmed
    ? "結果未確認。再送せずSlackで確認してください"
    : write.outcome?.kind === "succeeded" && read.status === "failed"
      ? "保存済み・一覧更新は未完了。Refreshで状態を確認してください"
      : (read.error ??
        (read.status === "loading"
          ? "本人のリアクションを確認中"
          : "本人のリアクションはありません"));
  const common = (
    <>
      <Action.Open
        title="Open Message in Slack"
        target={messageLink(session.display.teamId, hit)}
        application="Slack"
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={read.refresh}
      />
    </>
  );
  return (
    <List
      navigationTitle={mode === "add" ? "Add Reaction" : "Remove My Reaction"}
      isLoading={read.status === "loading" || write.busy}
      searchBarPlaceholder="絵文字を選択"
    >
      <List.EmptyView
        title={status}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      <List.Section
        title={
          write.outcome?.kind === "succeeded"
            ? "保存済み"
            : "本人のリアクション"
        }
        subtitle={read.error || write.unconfirmed ? status : undefined}
      >
        {read.status === "ready"
          ? names.map((name) => (
              <List.Item
                key={name}
                id={name}
                title={
                  STANDARD_REACTIONS.find((reaction) => reaction.name === name)
                    ?.label ?? `:${name}:`
                }
                accessories={
                  mode === "add" && mine.includes(name)
                    ? [{ icon: Icon.Check, tooltip: "本人が追加済み" }]
                    : []
                }
                actions={
                  <ActionPanel>
                    {!write.busy &&
                    !write.unconfirmed &&
                    !(mode === "add" && mine.includes(name)) ? (
                      <Action
                        title={
                          mode === "add" ? "Add Reaction" : "Remove My Reaction"
                        }
                        onAction={() => choose(name)}
                      />
                    ) : null}
                    {common}
                  </ActionPanel>
                }
              />
            ))
          : null}
      </List.Section>
    </List>
  );
}
