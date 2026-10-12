import { t } from "../../shared/i18n.ts";
import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { useState } from "react";
import type { Conversation, Person } from "../../shared/types.ts";
import type { ChannelLibrary } from "../channel-library/model.ts";
import {
  DEFAULT_SEARCH_SCOPE,
  validateScopeSelection,
  type SearchScope,
} from "./model.ts";
export type ScopeFormProps = {
  scope: SearchScope;
  library: ChannelLibrary;
  conversations: readonly Conversation[];
  people: readonly Person[];
  onApply: (
    scope: SearchScope,
    options: {
      showMessages?: boolean;
    },
  ) => void;
  onManage?: (
    library: ChannelLibrary,
    onChange: (library: ChannelLibrary) => void,
  ) => void;
};
export function ScopeForm({
  scope,
  library: initialLibrary,
  conversations,
  people,
  onApply,
  onManage,
}: ScopeFormProps) {
  const { pop } = useNavigation();
  const [library, setLibrary] = useState(initialLibrary);
  const [kind, setKind] = useState<SearchScope["range"]["kind"]>(
    scope.range.kind,
  );
  const [sectionId, setSectionId] = useState(
    scope.range.kind === "section"
      ? scope.range.sectionId
      : (library.sections[0]?.id ?? ""),
  );
  const channels = conversations
    .filter((c) => c.type !== "mpim")
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const [channelId, setChannelId] = useState(
    scope.range.kind === "channel"
      ? scope.range.channelId
      : (channels[0]?.id ?? ""),
  );
  const [senderId, setSenderId] = useState(scope.senderId ?? "");
  const [error, setError] = useState<string>();
  const apply = (showMessages = false) => {
    const range: SearchScope["range"] =
      kind === "section"
        ? { kind, sectionId }
        : kind === "channel"
          ? { kind, channelId }
          : { kind };
    const next = { range, ...(senderId ? { senderId } : {}) };
    const invalid = validateScopeSelection(
      next,
      library,
      conversations,
      showMessages,
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    onApply(next, { showMessages });
    pop();
  };
  return (
    <Form
      navigationTitle={t("検索条件を選ぶ")}
      actions={
        <ActionPanel>
          <Action title={t("適用")} onAction={() => apply()} />
          <Action title={t("メッセージを表示")} onAction={() => apply(true)} />
          <Action
            title={t("条件をクリアして適用")}
            onAction={() => {
              onApply(DEFAULT_SEARCH_SCOPE, {});
              pop();
            }}
          />
          {onManage && (
            <Action
              title={t("セクションを管理")}
              onAction={() =>
                onManage(library, (next) => {
                  setLibrary(next);
                  setError(undefined);
                })
              }
            />
          )}
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="range"
        title={t("検索範囲")}
        value={kind}
        onChange={(value) => {
          setKind(value as typeof kind);
          setError(undefined);
        }}
      >
        <Form.Dropdown.Item value="all" title={t("すべて")} />
        <Form.Dropdown.Item
          value="favorites"
          title={t("お気に入りチャンネル")}
        />
        <Form.Dropdown.Item value="section" title={t("セクション")} />
        <Form.Dropdown.Item value="channel" title={t("チャンネル")} />
      </Form.Dropdown>
      {kind === "section" && (
        <Form.Dropdown
          id="section"
          title={t("セクション")}
          value={sectionId}
          onChange={setSectionId}
          error={error}
        >
          {!library.sections.some((section) => section.id === sectionId) && (
            <Form.Dropdown.Item
              value={sectionId}
              title={
                sectionId
                  ? t("選択したセクションは削除されています")
                  : t("セクションを選んでください")
              }
            />
          )}
          {[...library.sections]
            .sort((a, b) => a.name.localeCompare(b.name, "ja"))
            .map((s) => (
              <Form.Dropdown.Item key={s.id} value={s.id} title={s.name} />
            ))}
        </Form.Dropdown>
      )}
      {kind === "channel" && (
        <Form.Dropdown
          id="channel"
          title={t("チャンネル")}
          value={channelId}
          onChange={setChannelId}
          error={error}
        >
          {channels.map((c) => (
            <Form.Dropdown.Item key={c.id} value={c.id} title={`#${c.name}`} />
          ))}
        </Form.Dropdown>
      )}
      <Form.Dropdown
        id="sender"
        title={t("投稿者")}
        value={senderId}
        onChange={(id) => {
          setSenderId(id);
          setError(undefined);
        }}
      >
        <Form.Dropdown.Item value="" title={t("指定なし")} />
        {people.map((p) => (
          <Form.Dropdown.Item
            key={p.id}
            value={p.id}
            title={p.displayName || p.realName || p.handle}
          />
        ))}
      </Form.Dropdown>
      <Form.Description
        text={
          error ??
          t(
            "範囲内の投稿と投稿者の両方に一致するメッセージを探します。適用するまで検索は始まりません。",
          )
        }
      />
    </Form>
  );
}
