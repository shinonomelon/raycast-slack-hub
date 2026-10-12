import { t, getLocale } from "../../shared/i18n.ts";
import type { Hit } from "../../slack/hits.ts";
import { toMarkdown, type NameLookup } from "../../slack/mrkdwn.ts";
import type { Names } from "../../slack/names.ts";
import { compareTs } from "../../slack/hits.ts";
import type { ThreadDetail } from "./use-thread-context.ts";
// 検索・履歴から取った全文を詳細に出す。保存した短い本文には取り直す操作を示す
export function messageDetailBody(
  hit: Hit,
  names: NameLookup,
  detailText?: string,
): string {
  const body = toMarkdown(detailText ?? hit.text, names);
  return hit.textIsPreview && detailText === undefined
    ? t("プレビュー（\u2318Rで全文を取得）\n\n{0}", body)
    : body;
}

// 名前をMarkdownの構文として解釈させず、投稿本文と混ぜない。
const labelText = (value: string) =>
  value.replace(/[\r\n]/g, " ").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");

export function messageTime(ts: string, now = new Date()): string {
  const date = new Date(Number(ts.split(".")[0]) * 1000);
  if (!Number.isFinite(date.getTime())) return t("不明");
  const otherYear = date.getFullYear() !== now.getFullYear();
  if (getLocale() === "ja-JP") {
    const weekday = new Intl.DateTimeFormat("ja-JP", {
      weekday: "short",
    }).format(date);
    const time = new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
    return t(
      "{0}{1}月{2}日（{3}）{4}",
      otherYear ? t("{0}年", date.getFullYear()) : "",
      date.getMonth() + 1,
      date.getDate(),
      weekday,
      time,
    );
  }
  return new Intl.DateTimeFormat(getLocale(), {
    ...(otherYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function threadDetailStatus(detail?: ThreadDetail): string | undefined {
  if (!detail) return undefined;
  if (detail.loading) return t("過去の投稿を取得中");
  const failure = detail.failure;
  if (failure?.kind === "scope")
    return t("過去の投稿には履歴権限が必要です。設定を確認してください");
  if (failure?.kind === "rate")
    return t(
      "Slackの回数制限です。{0}以降に詳細を更新してください",
      new Date(failure.retryAt ?? Date.now()).toLocaleTimeString(getLocale()),
    );
  if (failure?.kind === "missing")
    return t("この投稿のスレッドを取得できません。Slackで確認してください");
  if (failure)
    return t("過去の投稿を取得できませんでした。詳細を更新してください");
  if (detail.data?.capped)
    return t("取得上限に達しました。続きはSlackで確認してください");
  if (detail.data?.cursor)
    return t("取得途中です。直前の投稿がまだ含まれない場合があります");
  return undefined;
}

export function messageDetailMarkdown(
  hit: Hit,
  names: Names,
  detailText?: string,
  detail?: ThreadDetail,
): string {
  const data = detail?.data;
  const fetched = data?.messages.find((item) => item.ts === hit.ts);
  const selected = fetched ?? hit;
  const block = (item: Hit, selectedBlock: boolean) => {
    const marks = [
      selectedBlock ? t("選択したメッセージ") : undefined,
      data?.isThread && data.rootTs === item.ts
        ? t("スレッドの親投稿")
        : undefined,
    ].filter(Boolean);
    const body = messageDetailBody(
      item,
      names.lookup,
      selectedBlock ? (detailText ?? fetched?.text) : undefined,
    );
    return `**${labelText(names.sender(item))}**\n\n${labelText(messageTime(item.ts))}${marks.length ? ` · ${marks.join(" · ")}` : ""}\n\n${body || t("（本文なし）")}`;
  };
  const prior =
    data?.messages
      .filter(
        (item) =>
          item.channelId === hit.channelId && compareTs(item.ts, hit.ts) < 0,
      )
      .sort((a, b) => compareTs(b.ts, a.ts)) ?? [];
  const status = threadDetailStatus(detail);
  return [
    `### ${labelText(names.conversationLabel(hit))}`,
    block(selected, true),
    ...(status ? [status] : []),
    ...prior.map((item) => block(item, false)),
  ].join("\n\n---\n\n");
}
