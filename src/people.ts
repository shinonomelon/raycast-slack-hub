// 生のユーザー一覧から人の一覧を作る純粋な関数。@raycast/api を読み込まないので、node のテストから動かせる
import type { Person } from "./types.ts";

// slack-cli の users list（--format json）が返すユーザー。使う項目だけを書く
export type RawUser = {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; title?: string };
};

// 削除済み（退職者など）は除き、ボットには isBot を付けて残す。
// キャッシュに載せるので、プロフィール全体ではなく表示と検索に要る項目だけ残す
export function toPeople(raw: readonly RawUser[]): Person[] {
  return raw
    .filter((u) => !u.deleted)
    .map((u) => {
      const realName = u.profile?.real_name || u.real_name || u.name;
      return {
        id: u.id,
        handle: u.name,
        displayName: u.profile?.display_name || realName,
        realName,
        title: u.profile?.title ?? "",
        isBot: u.is_bot === true,
      };
    });
}

// 一覧の行に出す人。ボットは出さない（ボットは会話の相手として開くものではなく、行が増えるだけになる）
export function listedPeople(people: readonly Person[]): Person[] {
  return people.filter((p) => !p.isBot);
}

// メンションの候補。ボットも含める（自分のボットにメンションを付けて投稿することがあるため）
export function mentionCandidates(people: readonly Person[]): Person[] {
  return [...people];
}

// メンション欄に出す名前。メンション欄（TagPicker）は題の文字でしか絞り込めないので、
// 表示名・本名・ハンドルのどれで打っても候補に当たるよう、3つとも題に含める
export function mentionLabel(person: Person): string {
  const names =
    person.realName !== person.displayName
      ? `${person.realName} @${person.handle}`
      : `@${person.handle}`;
  return `${person.displayName}（${names}）`;
}
