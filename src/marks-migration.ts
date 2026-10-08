// 更新の前に付けた「対応済み」「開いた」の印を、新しい名前空間へ一度だけ移す判断。
// @raycast/api を読み込まないので、node のテストから動かせる（Cache との受け渡しは read-state.ts の migrateLegacyMarks）。
//
// 背景：自分の情報（ワークスペースと自分の ID）が決まる前の版は、印を名前空間 messages の marks・opened に持っていた。
// 今の版は、人ごとの名前空間（messages-<teamId>-<userId>）に持つ。移さないと、更新のあとの初回に、
// 過去7日の自分宛てが、対応済みのものも含めて出直す（対応済みの印は14日もつ）。

// 自分の情報が決まる前の名前空間。ここの値は、消さない・書き換えない（移した印のキーを足すだけ）
export const LEGACY_NAMESPACE = "messages";

// 移したことを、古い名前空間に残すキー。値は移した先（scopeKey。teamId-userId）
export const MIGRATED_TO_KEY = "migratedTo";

// 移すのはこの2つだけ。既読位置・整理の結果・お気に入りの検索の結果などは、Slack から取り直せるので移さない
export const MIGRATED_KEYS = ["marks", "opened"] as const;
export type MigratedKey = (typeof MIGRATED_KEYS)[number];

// Cache に入っている文字列（JSON）のまま受け渡す。無いもの・空の文字列は「無い」として扱う
export type StoredMarks = Partial<Record<MigratedKey, string>>;

// 書く値。namespace が書き先：legacy は古い名前空間、current は新しい名前空間
export type MigrationWrite = {
  namespace: "legacy" | "current";
  key: string;
  value: string;
};

const exists = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

// 印を移すかと、移すなら何を書くかを決める。書く値を、書く順に返す（移さないときは空）。
// 呼ぶのは、今回の whoami が成功した人（destination）についてだけ。
// - 古い名前空間に「移した」印があれば、移さない（あとで別のプロファイルの人が開いても、その人には移らない）
// - 新しい名前空間に marks か opened のどちらかでもあれば、移さない（この人の印を上書きしない）
// - 古い名前空間に marks も opened も無ければ、何もしない（印も書かない）
// - 移すときは、古い側にある方だけを新しい側へそのまま写し、最後に「移した」印を古い側に書く。
//   値を先に書き、印を最後にするのは、途中で止まっても、この人の印を失わないため。
//   古い側の marks・opened は消さない・書き換えない
export function planMarksMigration(input: {
  // 古い名前空間にある marks・opened
  legacy: StoredMarks;
  // 古い名前空間にある「移した」印（移した先の scopeKey）
  migratedTo: string | undefined;
  // 新しい名前空間にある marks・opened
  current: StoredMarks;
  // 移し先（今回の whoami が成功した人の scopeKey）
  destination: string;
}): MigrationWrite[] {
  const { legacy, migratedTo, current, destination } = input;
  if (exists(migratedTo)) return [];
  if (MIGRATED_KEYS.some((key) => exists(current[key]))) return [];

  const copies = MIGRATED_KEYS.flatMap((key): MigrationWrite[] => {
    const value = legacy[key];
    return exists(value) ? [{ namespace: "current", key, value }] : [];
  });
  if (copies.length === 0) return [];
  return [
    ...copies,
    { namespace: "legacy", key: MIGRATED_TO_KEY, value: destination },
  ];
}
