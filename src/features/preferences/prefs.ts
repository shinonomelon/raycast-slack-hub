import { environment, showToast, Toast } from "@raycast/api";
import {
  createNoticeOnce,
  createPrefsStore,
  type PrefsStore,
} from "./prefs-store.ts";
import type { Prefs } from "../../shared/types.ts";

// 読めなかった・壊れていたことを、トーストで1回だけ知らせる（console.warn だけでは本人に見えないため）。
// load は画面の描画の中で呼ばれるので、トーストは待たない。知らせられなくても、読み込みは止めない
const notify = createNoticeOnce((toast) => {
  try {
    void showToast({
      style: Toast.Style.Failure,
      title: toast.title,
      message: toast.message,
    }).catch(() => undefined);
  } catch {
    // 知らせられなかっただけで、設定の読み込みの結果は変わらない
  }
});

// 読み込みと保存の中身は prefs-store.ts。ここでは Raycast が決める保存場所を渡す。
// 読めなかったことの記憶（そのファイルを上書きしない）を呼び出しをまたいで持つため、1つを使い回す
let store: PrefsStore | undefined;
const prefsStore = (): PrefsStore =>
  (store ??= createPrefsStore(environment.supportPath, { notify }));

export const loadPrefs = (): Prefs => prefsStore().load();
export const savePrefs = (prefs: Prefs): void => prefsStore().save(prefs);
