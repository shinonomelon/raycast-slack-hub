import type { Block } from "./md-to-blocks.ts";

// https://docs.slack.dev/reference/block-kit/blocks/section-block/
export const SECTION_TEXT_LIMIT = 3000;
// https://docs.slack.dev/reference/block-kit/blocks/
export const MESSAGE_BLOCK_LIMIT = 50;

export class MessageLimitError extends Error {}

// 変換後のペイロードを検査し、DMを開く処理も含めたAPI呼び出しの前に止める。
export function validateMessageBlocks(blocks: readonly Block[]): void {
  if (blocks.length > MESSAGE_BLOCK_LIMIT)
    throw new MessageLimitError(
      "本文がSlackの50 blocks上限を超えています。本文を分けて投稿してください。投稿は送信していません",
    );
  for (const block of blocks) {
    if (block.type !== "section") continue;
    const text = (block.text as { text?: unknown } | undefined)?.text;
    if (
      typeof text !== "string" ||
      text.length < 1 ||
      text.length > SECTION_TEXT_LIMIT
    )
      throw new MessageLimitError(
        "本文がSlackのsectionの1〜3000文字上限に収まりません。本文を確認してください。投稿は送信していません",
      );
  }
}
