import { Cache } from "@raycast/api";
import {
  mergePause,
  parsePause,
  serializePause,
  type GateKind,
  type Pause,
} from "./search-gate.ts";

// 止める期限の保存。値の読み書きの判断は search-gate.ts の純粋な関数に任せ、ここは Cache との受け渡しだけにする
// （Cache を値として読むので、node のテストからは読み込めない）。
// 閉じて開き直しても止まったままになるよう、ディスク上の Cache に持つ。
// 名前空間を分けないと、@raycast/utils（useFrecencySorting）が同じフォルダに作る別の Cache と
// 索引（journal）を互いに上書きし合う（directory.ts の Cache と同じ理由）
const cache = new Cache({ namespace: "search-gate" });

// いま止めている期限。種類ごとに別々（検索と既読位置の取得は、Slack の API の種類が違い、回数制限も別に数えられる）
export function readPause(kind: GateKind, now = Date.now()): Pause | undefined {
  return parsePause(cache.get(kind), now);
}

// 止める期限を書く。すでにあるより前にはしない。保存できなくても、検索は止めたものとして続ける
export function writePause(kind: GateKind, pause: Pause): Pause {
  const merged = mergePause(readPause(kind), pause);
  try {
    cache.set(kind, serializePause(merged));
  } catch {
    // 保存できなかっただけで、この回の画面は止まる。次に開いたときは、止めずに検索する
  }
  return merged;
}
