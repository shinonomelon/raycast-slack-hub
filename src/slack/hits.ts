export type ChannelKind = "channel" | "private" | "im" | "mpim";

// search.messages の1件を、画面と判定に要る項目だけに縮めたもの
export type Hit = {
  // 会話とメッセージで一意。同じメッセージが複数の検索に出ても1件にまとめるのに使う
  key: string;
  channelId: string;
  ts: string;
  // スレッドの親の ts。スレッド返信のときだけ入る（親そのものには入らない）
  threadTs?: string;
  permalink: string;
  userId?: string;
  username?: string;
  // Slack の書式のまま全文を持つ。Cacheへ保存するときだけ短いコピーにする
  text: string;
  // 保存したプレビューで本文が切れている。通信で取得した全文には付けない
  textIsPreview?: boolean;
  channelName?: string;
  channelKind: ChannelKind;
  // 本文に自分へのメンションがあるか
  mentionsSelf: boolean;
};

// Slack の ts（"1790967145.033309"）を比べる。parseFloat は16桁で精度が落ちるので、秒と小数部を分けて整数で比べる
export function compareTs(a: string, b: string): number {
  const [aSec = "0", aFrac = ""] = a.split(".");
  const [bSec = "0", bFrac = ""] = b.split(".");
  const sec = Number(aSec) - Number(bSec);
  if (sec !== 0) return sec < 0 ? -1 : 1;
  const frac = Number(aFrac.padEnd(6, "0")) - Number(bFrac.padEnd(6, "0"));
  return frac === 0 ? 0 : frac < 0 ? -1 : 1;
}

// permalink から会話の ID、メッセージの ts、スレッドの親の ts を取り出す。
// 例: https://x.slack.com/archives/C0123/p1790967145033309?thread_ts=1790967145.000100&cid=C0123
export function parsePermalink(
  url: string,
): { channelId: string; ts: string; threadTs?: string } | undefined {
  const match = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?|$|#)/.exec(url);
  if (!match) return undefined;
  const [, channelId, sec, frac] = match;
  let threadTs: string | undefined;
  try {
    threadTs = new URL(url).searchParams.get("thread_ts") ?? undefined;
  } catch {
    threadTs = undefined;
  }
  return { channelId, ts: `${sec}.${frac}`, threadTs };
}

// スレッド返信か。スレッドの親は thread_ts と ts が同じなので返信ではない
export function isThreadReply(hit: Pick<Hit, "ts" | "threadTs">): boolean {
  return hit.threadTs !== undefined && hit.threadTs !== hit.ts;
}

// Slack アプリでメッセージを開くリンク。スレッド返信は親の ts も付けるとスレッドが開く（2026年10月4日に実機で確認）
export function messageLink(
  teamId: string,
  hit: Pick<Hit, "channelId" | "ts" | "threadTs">,
): string {
  const base = `slack://channel?team=${teamId}&id=${hit.channelId}&message=${hit.ts}`;
  return isThreadReply(hit) ? `${base}&thread_ts=${hit.threadTs}` : base;
}

type RawChannel = {
  id?: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_group?: boolean;
};

type RawMatch = {
  ts?: string;
  text?: string;
  user?: string;
  username?: string;
  permalink?: string;
  channel?: RawChannel;
  attachments?: { fallback?: string; text?: string; pretext?: string }[];
};

function channelKind(channel: RawChannel, channelId: string): ChannelKind {
  if (channel.is_im) return "im";
  if (channel.is_mpim) return "mpim";
  if (channel.is_private || channel.is_group) return "private";
  // 種類の印が無いときは ID の頭で見分ける（D は DM）
  return channelId.startsWith("D") ? "im" : "channel";
}

// bot の投稿は text が空で、添付に本文があることがある
function bodyOf(m: RawMatch): string {
  if (m.text) return m.text;
  const attachment = m.attachments?.find(
    (a) => a.text || a.fallback || a.pretext,
  );
  return attachment?.text || attachment?.fallback || attachment?.pretext || "";
}

// search.messages の match を Hit にする。会話の ID か ts が分からないものは捨てる
export function normalizeMatch(raw: unknown, selfId: string): Hit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as RawMatch;
  const fromLink = m.permalink ? parsePermalink(m.permalink) : undefined;
  const channelId = m.channel?.id ?? fromLink?.channelId;
  const ts = m.ts ?? fromLink?.ts;
  if (!channelId || !ts) return undefined;
  const body = bodyOf(m);
  return {
    key: `${channelId}:${ts}`,
    channelId,
    ts,
    threadTs: fromLink?.threadTs,
    permalink: m.permalink ?? "",
    userId: m.user || undefined,
    username: m.username || undefined,
    text: body,
    channelName: m.channel?.name || undefined,
    channelKind: channelKind(m.channel ?? {}, channelId),
    mentionsSelf:
      body.includes(`<@${selfId}>`) || body.includes(`<@${selfId}|`),
  };
}
