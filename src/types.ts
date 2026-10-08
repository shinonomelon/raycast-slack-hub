// 型だけを置くファイル。node のテストから読めるよう、型でない値は持たない。
// search.ts の型は import type で読む（値として読むと、テストの読み込みが連鎖して増える）
import type { DictionaryRule, Membership } from "./search.ts";

export type Conversation = {
  id: string;
  name: string;
  type: "public" | "private" | "mpim";
};

export type Person = {
  id: string;
  handle: string;
  displayName: string;
  realName: string;
  title: string;
  // ボット。一覧の人の行には出さず、メンションの候補にだけ出す
  isBot: boolean;
};

// 自分用の設定。お気に入り、項目ごとの別名、名前の置き換え辞書
export type Prefs = {
  favorites: string[];
  aliases: Record<string, string[]>;
  dictionary: DictionaryRule[];
  // 参加しているかの絞り込み。Open Channel から引き継ぐ値でもあるので、Raycast の storeValue ではなくここで覚える
  membership: Membership;
};

// slack-cli の channel last-read が、既読位置を取れなかった理由。
// no_last_read は応答に last_read が無い（参加していないチャンネルなど）、not_visible は会話が見えない、
// rate_limited は回数制限、error はそれ以外の Slack のエラーと通信・HTTP の失敗
export type LastReadReason =
  "no_last_read" | "not_visible" | "rate_limited" | "error";

// channel last-read --format json の1行（会話ごと）。取れたときは lastRead が入り、reason は null
export type LastReadRow = {
  channelId: string;
  lastRead: string | null;
  reason: LastReadReason | null;
  // reason が rate_limited のときだけ付く、再試行までに待つ秒数
  retryAfter?: number;
};

// slack-cli を1回呼んだ結果。slack-cli.ts が返し、compose.ts が送信の結果を分類するのに読む
export type CliResult = {
  // 終了コード。シグナルで終わったときは null
  code: number | null;
  // 終わらせたシグナルの名前。自分で終わったときは null
  signal: string | null;
  stdout: string;
  stderr: string;
  // 時間切れで止めた
  timedOut: boolean;
  // AbortSignal で中断した
  aborted: boolean;
};
