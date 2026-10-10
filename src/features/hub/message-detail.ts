import type { Hit } from "../../slack/hits.ts";
import { toMarkdown, type NameLookup } from "../../slack/mrkdwn.ts";

// 検索・履歴から取った全文を詳細に出す。保存した短い本文には取り直す操作を示す
export function messageDetailBody(
  hit: Hit,
  names: NameLookup,
  detailText?: string,
): string {
  const body = toMarkdown(detailText ?? hit.text, names);
  return hit.textIsPreview && detailText === undefined
    ? `プレビュー（⌘Rで全文を取得）\n\n${body}`
    : body;
}
