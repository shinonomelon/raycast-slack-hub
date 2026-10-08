import { CONVERSATIONS, JOINED, PEOPLE, refreshIfStale } from "./directory.ts";
import { fetchIdentity } from "./identity.ts";
import { refreshAll } from "./refresh-all.ts";
import { readSettings } from "./settings.ts";

// 5分おきに裏で起動し、古くなった一覧だけを取り直してキャッシュに書く。
// チャンネルや人の一覧は、それぞれの期限が来たときだけ取る。
// ウィンドウとは関係なく動くので、25秒ほどかかる人の取得も最後まで終わる。
// 先に設定を読んで whoami を呼び、取れた人（ワークスペースと自分の ID）の名前空間に書く。
// 取れなければ、何も取らず、書かず、理由を出して終える（取り直すか終えるかの判断は refresh-all.ts の planRefresh。
// このコマンドは、必ずそれを通る refreshAll を呼ぶ）
export default async function Command() {
  await refreshAll({
    whoami: () => fetchIdentity(readSettings()),
    dirs: [CONVERSATIONS, PEOPLE, JOINED],
    refresh: (dir, identity) => refreshIfStale<unknown>(dir, identity),
    log: (line) => console.log(line),
  });
}
