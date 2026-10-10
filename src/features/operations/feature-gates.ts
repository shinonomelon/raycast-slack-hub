import type { ChannelKind } from "../../slack/hits.ts";

// 実APIゲートの証拠がそろうまで有効化しない。利用者・ワークスペース固有の設定は持たない。
export const FEATURE_GATES = {
  history: {
    channel: false,
    private: false,
    im: false,
    mpim: false,
  } satisfies Record<ChannelKind, boolean>,
  threadReplyTs: false,
  reactionsRead: false,
  reactionsWrite: false,
  bookmarksRead: false,
  bookmarksWrite: false,
  listsRead: false,
  listsWrite: false,
  listsClearValues: false,
};
