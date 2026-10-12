// 表示用の文言。Slack本文・検索式・AIへの指示文は含めない。
export const messages = {
  "Slack APIの回数制限です": {
    ja: "Slack APIの回数制限です",
    en: "Slack API rate limit reached",
  },
  "Slack APIの取得を延期しました": {
    ja: "Slack APIの取得を延期しました",
    en: "Slack API request is waiting",
  },
  "Slack APIへの通信が時間切れになりました": {
    ja: "Slack APIへの通信が時間切れになりました",
    en: "Slack API request timed out",
  },
  一覧を取得中です: {
    ja: "一覧を取得中です",
    en: "Directory refresh is in progress",
  },
  一覧の取得を一時停止しています: {
    ja: "一覧の取得を一時停止しています",
    en: "Directory refresh is paused",
  },
  再読み込みで取得を続けられます: {
    ja: "再読み込みで取得を続けられます",
    en: "Reload to continue fetching",
  },
  チャンネル: {
    ja: "チャンネル",
    en: "Channels",
  },
  メンバー: {
    ja: "メンバー",
    en: "People",
  },
  参加中のチャンネル: {
    ja: "参加中のチャンネル",
    en: "Joined channels",
  },
  "{0}の一覧を更新できませんでした": {
    ja: "{0}の一覧を更新できませんでした",
    en: "Could not refresh {0}",
  },
  "Slack Access Tokenを設定してください": {
    ja: "Slack Access Tokenを設定してください",
    en: "Set your Slack Access Token",
  },
  Slackに自分の情報を問い合わせられませんでした: {
    ja: "Slackに自分の情報を問い合わせられませんでした",
    en: "Could not retrieve your Slack account information",
  },
  "拡張の設定のSlack Access Tokenに、自分のUser OAuth Tokenを入れてください": {
    ja: "拡張の設定のSlack Access Tokenに、自分のUser OAuth Tokenを入れてください",
    en: "Enter your User OAuth Token in Slack Access Token in the extension preferences",
  },
  "Bot Tokenは使用できません。User OAuth Tokenを設定してください": {
    ja: "Bot Tokenは使用できません。User OAuth Tokenを設定してください",
    en: "Bot Tokens are not supported. Set a User OAuth Token",
  },
  "auth.testの応答を読み取れませんでした": {
    ja: "auth.testの応答を読み取れませんでした",
    en: "Could not read the auth.test response",
  },
  "{0}。Slack Access Tokenと権限を確認してください": {
    ja: "{0}。Slack Access Tokenと権限を確認してください",
    en: "{0}. Check your Slack Access Token and permissions",
  },
  グループDM: {
    ja: "グループDM",
    en: "Group DM",
  },
  不明: {
    ja: "不明",
    en: "Unknown",
  },
  "Slack Access TokenにUser OAuth Token（xoxp-）を設定してください": {
    ja: "Slack Access TokenにUser OAuth Token（xoxp-）を設定してください",
    en: "Set a User OAuth Token (xoxp-) in Slack Access Token",
  },
  "Slack APIの回数制限です。{0}秒後に再試行してください": {
    ja: "Slack APIの回数制限です。{0}秒後に再試行してください",
    en: "Slack API rate limit. Retry in {0} seconds",
  },
  通信を中断しました: {
    ja: "通信を中断しました",
    en: "Request cancelled",
  },
  "Slack APIのHTTPエラー（{0}）": {
    ja: "Slack APIのHTTPエラー（{0}）",
    en: "Slack API HTTP error ({0})",
  },
  "Slack APIの応答を読み取れませんでした": {
    ja: "Slack APIの応答を読み取れませんでした",
    en: "Could not read the Slack API response",
  },
  "Slack APIの回数制限です。60秒後に再試行してください": {
    ja: "Slack APIの回数制限です。60秒後に再試行してください",
    en: "Slack API rate limit. Retry in 60 seconds",
  },
  "（必要な権限: {0}）": {
    ja: "（必要な権限: {0}）",
    en: "(required permissions: {0})",
  },
  "Slack APIの応答にokがありません": {
    ja: "Slack APIの応答にokがありません",
    en: "The Slack API response has no ok field",
  },
  "Slack APIへの通信が{0}秒で時間切れになりました": {
    ja: "Slack APIへの通信が{0}秒で時間切れになりました",
    en: "Slack API request timed out after {0} seconds",
  },
  "Slack APIとの通信に失敗しました": {
    ja: "Slack APIとの通信に失敗しました",
    en: "Could not connect to the Slack API",
  },
  一覧の取得が時間切れになりました: {
    ja: "一覧の取得が時間切れになりました",
    en: "Directory request timed out",
  },
  一覧の応答を読み取れませんでした: {
    ja: "一覧の応答を読み取れませんでした",
    en: "Could not read the directory response",
  },
  一覧のカーソルが繰り返されました: {
    ja: "一覧のカーソルが繰り返されました",
    en: "The directory returned a repeated cursor",
  },
  検索結果にmatchesがありません: {
    ja: "検索結果にmatchesがありません",
    en: "The search response has no matches field",
  },
  既読位置の取得が時間切れになりました: {
    ja: "既読位置の取得が時間切れになりました",
    en: "Read position request timed out",
  },
  既読位置の応答の会話IDが一致しません: {
    ja: "既読位置の応答の会話IDが一致しません",
    en: "The read position response has a different conversation ID",
  },
  アカウント識別情報が不正です: {
    ja: "アカウント識別情報が不正です",
    en: "Invalid account identity",
  },
  チャンネルIDの保存データが不正です: {
    ja: "チャンネルIDの保存データが不正です",
    en: "Invalid saved channel IDs",
  },
  "セクション名は1〜100文字で入力してください": {
    ja: "セクション名は1〜100文字で入力してください",
    en: "Enter a section name between 1 and 100 characters",
  },
  "整理ファイルが壊れています。復旧してから再読み込みしてください": {
    ja: "整理ファイルが壊れています。復旧してから再読み込みしてください",
    en: "The channel library file is corrupted. Restore it before reloading",
  },
  アカウントの保存データが不正です: {
    ja: "アカウントの保存データが不正です",
    en: "Invalid saved account data",
  },
  保存先アカウントが一致しません: {
    ja: "保存先アカウントが一致しません",
    en: "The destination account does not match",
  },
  セクションIDの保存データが不正です: {
    ja: "セクションIDの保存データが不正です",
    en: "Invalid saved section IDs",
  },
  同名のセクションが保存されています: {
    ja: "同名のセクションが保存されています",
    en: "Duplicate section names in saved data",
  },
  旧お気に入りの取り込み記録が不正です: {
    ja: "旧お気に入りの取り込み記録が不正です",
    en: "Invalid legacy favorites migration record",
  },
  "セクションが削除されています。再読み込みしてください": {
    ja: "セクションが削除されています。再読み込みしてください",
    en: "This section was deleted. Reload the library",
  },
  同じ名前のセクションがあります: {
    ja: "同じ名前のセクションがあります",
    en: "A section with this name already exists",
  },
  名前を入力してください: {
    ja: "名前を入力してください",
    en: "Enter a name",
  },
  "保存できませんでした。名前の重複や整理ファイルの状態を確認してください": {
    ja: "保存できませんでした。名前の重複や整理ファイルの状態を確認してください",
    en: "Could not save. Check for duplicate names or a problem with the channel library file",
  },
  保存できませんでした: {
    ja: "保存できませんでした",
    en: "Could not save",
  },
  保存: {
    ja: "保存",
    en: "Save",
  },
  所属チャンネル: {
    ja: "所属チャンネル",
    en: "Channels in Section",
  },
  "{0}（現在参照できません）": {
    ja: "{0}（現在参照できません）",
    en: "{0} (currently unavailable)",
  },
  セクション名: {
    ja: "セクション名",
    en: "Section Name",
  },
  "保存するまで変更は反映されません。お気に入りとセクション所属は独立しています。":
    {
      ja: "保存するまで変更は反映されません。お気に入りとセクション所属は独立しています。",
      en: "Changes take effect when saved. Favorites and section membership are independent.",
    },
  整理データを保存できませんでした: {
    ja: "整理データを保存できませんでした",
    en: "Could not save the channel library",
  },
  セクションを作成: {
    ja: "セクションを作成",
    en: "Create Section",
  },
  セクションを管理: {
    ja: "セクションを管理",
    en: "Manage Sections",
  },
  セクションを探す: {
    ja: "セクションを探す",
    en: "Search sections",
  },
  "{0}チャンネル": {
    ja: "{0}チャンネル",
    en: "{0} channels",
  },
  所属チャンネルを編集: {
    ja: "所属チャンネルを編集",
    en: "Edit Channels",
  },
  "{0}の所属": {
    ja: "{0}の所属",
    en: "Channels in {0}",
  },
  名前を変更: {
    ja: "名前を変更",
    en: "Rename",
  },
  セクションを削除: {
    ja: "セクションを削除",
    en: "Delete Section",
  },
  "「{0}」を削除しますか？": {
    ja: "「{0}」を削除しますか？",
    en: 'Delete "{0}"?',
  },
  "このセクションの所属設定を削除します。": {
    ja: "このセクションの所属設定を削除します。",
    en: "This removes the section and its channel membership settings.",
  },
  削除: {
    ja: "削除",
    en: "Delete",
  },
  セクションがありません: {
    ja: "セクションがありません",
    en: "No sections",
  },
  Actionsからセクションを作成できます: {
    ja: "Actionsからセクションを作成できます",
    en: "Create a section from Actions",
  },
  "#{0}の所属": {
    ja: "#{0}の所属",
    en: "Sections for #{0}",
  },
  "保存できませんでした。再試行してください": {
    ja: "保存できませんでした。再試行してください",
    en: "Could not save. Please try again",
  },
  所属セクション: {
    ja: "所属セクション",
    en: "Sections",
  },
  "複数のセクションへ所属できます。お気に入りを外しても所属は変わりません。": {
    ja: "複数のセクションへ所属できます。お気に入りを外しても所属は変わりません。",
    en: "A channel can belong to multiple sections. Removing a favorite does not change its sections.",
  },
  "整理ファイルがサイズ上限を超えています。復旧してから再読み込みしてください":
    {
      ja: "整理ファイルがサイズ上限を超えています。復旧してから再読み込みしてください",
      en: "The channel library file exceeds the size limit. Restore it before reloading",
    },
  "整理ファイルを読めません。正本を復旧してから再読み込みしてください": {
    ja: "整理ファイルを読めません。正本を復旧してから再読み込みしてください",
    en: "Could not read the channel library file. Restore it before reloading",
  },
  "別の画面またはプロセスが保存中です。再試行してください": {
    ja: "別の画面またはプロセスが保存中です。再試行してください",
    en: "Another view or process is saving. Please try again",
  },
  "保存ロックの所有者を確認できません。整理ファイルを保護したままロックを復旧してください":
    {
      ja: "保存ロックの所有者を確認できません。整理ファイルを保護したままロックを復旧してください",
      en: "Could not verify the save lock owner. Recover the lock while protecting the channel library file",
    },
  "整理データがサイズ上限を超えています。保存内容を減らしてください": {
    ja: "整理データがサイズ上限を超えています。保存内容を減らしてください",
    en: "The channel library exceeds the size limit. Reduce the saved data",
  },
  ディレクトリ取得完了後に整理データを初期化してください: {
    ja: "ディレクトリ取得完了後に整理データを初期化してください",
    en: "Wait for the directory to load before initializing the channel library",
  },
  "整理データを保存できませんでした。再試行してください": {
    ja: "整理データを保存できませんでした。再試行してください",
    en: "Could not save the channel library. Please try again",
  },
  本文を入力してください: {
    ja: "本文を入力してください",
    en: "Enter a message",
  },
  投稿しています: {
    ja: "投稿しています",
    en: "Posting",
  },
  投稿しました: {
    ja: "投稿しました",
    en: "Posted",
  },
  "Slack を開けませんでした（{0}）": {
    ja: "Slack を開けませんでした（{0}）",
    en: "Could not open Slack ({0})",
  },
  送れたか未確認です: {
    ja: "送れたか未確認です",
    en: "Delivery has not been confirmed",
  },
  投稿に失敗しました: {
    ja: "投稿に失敗しました",
    en: "Could not post",
  },
  "もう一度送りますか？": {
    ja: "もう一度送りますか？",
    en: "Send again?",
  },
  "Send Again": {
    ja: "再送信",
    en: "Send Again",
  },
  "{0} のスレッドに返信": {
    ja: "{0} のスレッドに返信",
    en: "Reply in a thread in {0}",
  },
  "{0} に書く": {
    ja: "{0} に書く",
    en: "Write to {0}",
  },
  "Post and Open in Slack": {
    ja: "投稿してSlackで開く",
    en: "Post and Open in Slack",
  },
  Preview: {
    ja: "プレビュー",
    en: "Preview",
  },
  プレビュー: {
    ja: "プレビュー",
    en: "Preview",
  },
  "_（本文なし）_": {
    ja: "_（本文なし）_",
    en: "_(No message body)_",
  },
  宛先: {
    ja: "宛先",
    en: "Destination",
  },
  "{0}（スレッドへの返信）": {
    ja: "{0}（スレッドへの返信）",
    en: "{0} (thread reply)",
  },
  認証: {
    ja: "認証",
    en: "Authentication",
  },
  "認証が完了していないため投稿できません。Slack Access Tokenを確認し、Slack Hubを開き直してください。":
    {
      ja: "認証が完了していないため投稿できません。Slack Access Tokenを確認し、Slack Hubを開き直してください。",
      en: "Cannot post before authentication completes. Check your Slack Access Token and reopen Slack Hub.",
    },
  本文: {
    ja: "本文",
    en: "Message",
  },
  "Markdown で書けます": {
    ja: "Markdown で書けます",
    en: "Markdown supported",
  },
  メンション: {
    ja: "メンション",
    en: "Mention",
  },
  "打つと名前・ハンドルで絞り込み（空ならメンションなし）": {
    ja: "打つと名前・ハンドルで絞り込み（空ならメンションなし）",
    en: "Type to filter by name or handle (leave empty for no mention)",
  },
  "{0}（グループDM）": {
    ja: "{0}（グループDM）",
    en: "{0} (group DM)",
  },
  スレッド内の返信: {
    ja: "スレッド内の返信",
    en: "Thread replies",
  },
  返信先: {
    ja: "返信先",
    en: "Replying to",
  },
  "（本文なし）": {
    ja: "（本文なし）",
    en: "(No message body)",
  },
  "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ返信が二重になります。先にスレッドの親を開いて、返信が付いたか確かめてください。":
    {
      ja: "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ返信が二重になります。先にスレッドの親を開いて、返信が付いたか確かめてください。",
      en: "Delivery of the previous reply is unknown. Sending again may create a duplicate. Open the parent message first to check whether your reply arrived.",
    },
  "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ投稿が二重になります。先に宛先の会話を開いて、確かめてください。":
    {
      ja: "前回は、届いたかどうかが分かっていません。届いていた場合は、同じ投稿が二重になります。先に宛先の会話を開いて、確かめてください。",
      en: "Delivery of the previous message is unknown. Sending again may create a duplicate. Open the destination conversation first to check whether it arrived.",
    },
  "投稿の応答を読み取れませんでした。Slackには届いている可能性があります": {
    ja: "投稿の応答を読み取れませんでした。Slackには届いている可能性があります",
    en: "Could not read the posting response. Your message may have reached Slack",
  },
  "{0}。Slackには届いている可能性があります。送信先を確認してください": {
    ja: "{0}。Slackには届いている可能性があります。送信先を確認してください",
    en: "{0}. Your message may have reached Slack. Check the destination",
  },
  "リンク・メンション・文字がSlackのsectionの3000文字上限に収まりません。短くして投稿してください。投稿は送信していません":
    {
      ja: "リンク・メンション・文字がSlackのsectionの3000文字上限に収まりません。短くして投稿してください。投稿は送信していません",
      en: "Links, mentions, or text exceed Slack's 3,000-character section limit. Shorten the message. Nothing was sent",
    },
  "本文がSlackの50 blocks上限を超えています。本文を分けて投稿してください。投稿は送信していません":
    {
      ja: "本文がSlackの50 blocks上限を超えています。本文を分けて投稿してください。投稿は送信していません",
      en: "The message exceeds Slack's 50-block limit. Split it into separate posts. Nothing was sent",
    },
  "本文がSlackのsectionの1〜3000文字上限に収まりません。本文を確認してください。投稿は送信していません":
    {
      ja: "本文がSlackのsectionの1〜3000文字上限に収まりません。本文を確認してください。投稿は送信していません",
      en: "The message does not fit Slack's 1–3,000-character section limit. Check the message. Nothing was sent",
    },
  宛先と本文を確認してください: {
    ja: "宛先と本文を確認してください",
    en: "Check the destination and message",
  },
  本文を変換できませんでした: {
    ja: "本文を変換できませんでした",
    en: "Could not convert the message",
  },
  "DMの会話IDを取得できませんでした。投稿は送信していません": {
    ja: "DMの会話IDを取得できませんでした。投稿は送信していません",
    en: "Could not get the DM conversation ID. Nothing was sent",
  },
  "トークンとim:write権限を確認してください": {
    ja: "トークンとim:write権限を確認してください",
    en: "Check your token and im:write permission",
  },
  "DMを開けませんでした（{0}）。投稿は送信していません": {
    ja: "DMを開けませんでした（{0}）。投稿は送信していません",
    en: "Could not open the DM ({0}). Nothing was sent",
  },
  "DMの取得が時間切れになりました。投稿は送信していません": {
    ja: "DMの取得が時間切れになりました。投稿は送信していません",
    en: "DM request timed out. Nothing was sent",
  },
  すべて: {
    ja: "すべて",
    en: "All",
  },
  参加中: {
    ja: "参加中",
    en: "Joined",
  },
  未参加: {
    ja: "未参加",
    en: "Not Joined",
  },
  検索が時間切れでした: {
    ja: "検索が時間切れでした",
    en: "Search timed out",
  },
  "Slack の回数制限に当たりました": {
    ja: "Slack の回数制限に当たりました",
    en: "Slack rate limit reached",
  },
  "{0} まで検索を止めます（そのあと、Reload Searchか入力で検索します）": {
    ja: "{0} まで検索を止めます（そのあと、「検索を更新」か入力で検索します）",
    en: "Search paused until {0}. Then reload search or type to search again",
  },
  検索に失敗しました: {
    ja: "検索に失敗しました",
    en: "Search failed",
  },
  "Open Extension Preferences": {
    ja: "拡張機能の設定を開く",
    en: "Open Extension Preferences",
  },
  "Slack に自分の情報を問い合わせています": {
    ja: "Slack に自分の情報を問い合わせています",
    en: "Retrieving your Slack account information",
  },
  "選択したセクションは削除されています。検索条件を選び直してください": {
    ja: "選択したセクションは削除されています。検索条件を選び直してください",
    en: "The selected section was deleted. Choose search filters again",
  },
  "参照できないチャンネル{0}件を除外しています。ディレクトリを更新してください":
    {
      ja: "参照できないチャンネル{0}件を除外しています。ディレクトリを更新してください",
      en: "Excluded {0} unavailable channels. Refresh the directory",
    },
  "Swap Conversations and Messages": {
    ja: "会話とメッセージを入れ替え",
    en: "Swap Conversations and Messages",
  },
  "Reload Search": {
    ja: "検索を更新",
    en: "Reload Search",
  },
  "Reload Conversations and People": {
    ja: "会話と人の一覧を更新",
    en: "Reload Conversations and People",
  },
  検索条件をまだ開けません: {
    ja: "検索条件をまだ開けません",
    en: "Search filters are not ready",
  },
  "チャンネル一覧の取得完了を待つか、一覧を更新してください": {
    ja: "チャンネル一覧の取得完了を待つか、一覧を更新してください",
    en: "Wait for the channel directory to load or refresh it",
  },
  検索条件を選ぶ: {
    ja: "検索条件を選ぶ",
    en: "Choose Search Filters",
  },
  続きを取得: {
    ja: "続きを取得",
    en: "Continue Search",
  },
  "Hide Details": {
    ja: "詳細を閉じる",
    en: "Hide Details",
  },
  "チャンネル・人・グループDMを検索（in: from: to: でメッセージを検索）": {
    ja: "チャンネル・人・グループDMを検索（in: from: to: でメッセージを検索）",
    en: "Search channels, people, and group DMs (in: from: to: for messages)",
  },
  参加しているかで絞る: {
    ja: "参加しているかで絞る",
    en: "Filter by membership",
  },
  返信待ち: {
    ja: "返信待ち",
    en: "Awaiting Reply",
  },
  見つかりません: {
    ja: "見つかりません",
    en: "No results",
  },
  "{0}では見つかりません": {
    ja: "{0}では見つかりません",
    en: "No results in {0}",
  },
  "検索欄の右のドロップダウンで、参加中・未参加の絞り込みを切り替えられます": {
    ja: "検索欄の右のドロップダウンで、参加中・未参加の絞り込みを切り替えられます",
    en: "Use the dropdown next to the search field to change the joined-channel filter",
  },
  チャンネル一覧と整理データを更新: {
    ja: "チャンネル一覧と整理データを更新",
    en: "Refresh Channels and Library",
  },
  候補: {
    ja: "候補",
    en: "Suggestions",
  },
  "Use This Candidate": {
    ja: "この候補を使う",
    en: "Use This Candidate",
  },
  "「{0}」の相手が決まりません": {
    ja: "「{0}」の相手が決まりません",
    en: 'Could not resolve "{0}"',
  },
  "候補から選ぶか、正式名で打ってください（この絞り込みは送りません）": {
    ja: "候補から選ぶか、正式名で打ってください（この絞り込みは送りません）",
    en: "Choose a suggestion or enter the exact name (this filter will not be sent)",
  },
  会話: {
    ja: "会話",
    en: "Conversations",
  },
  "未読（件数は下限）": {
    ja: "未読（件数は下限）",
    en: "Unread (count is a lower bound)",
  },
  未読: {
    ja: "未読",
    en: "Unread",
  },
  お気に入り: {
    ja: "お気に入り",
    en: "Favorites",
  },
  "Open in Slack": {
    ja: "Slackで開く",
    en: "Open in Slack",
  },
  Write: {
    ja: "投稿する",
    en: "Write",
  },
  "View Channels with This Person": {
    ja: "この人がいるチャンネルを表示",
    en: "View Channels with This Person",
  },
  "View Members": {
    ja: "参加者を表示",
    en: "View Members",
  },
  このチャンネルでメッセージを検索: {
    ja: "このチャンネルでメッセージを検索",
    en: "Search Messages in This Channel",
  },
  セクションへの所属: {
    ja: "セクションへの所属",
    en: "Section Membership",
  },
  "Edit Aliases": {
    ja: "別名を編集",
    en: "Edit Aliases",
  },
  "Edit Dictionary": {
    ja: "辞書を編集",
    en: "Edit Dictionary",
  },
  "Copy ID": {
    ja: "IDをコピー",
    en: "Copy ID",
  },
  "Reset Ranking": {
    ja: "順位をリセット",
    en: "Reset Ranking",
  },
  "自分宛て（過去7日）": {
    ja: "メンション・DM（過去7日）",
    en: "Mentions & DMs (Past 7 Days)",
  },
  "{0} 件": {
    ja: "{0} 件",
    en: "{0} results",
  },
  メッセージ: {
    ja: "メッセージ",
    en: "Messages",
  },
  "{0}{1} 件": {
    ja: "{0}{1} 件",
    en: "{0}{1} results",
  },
  取得済み: {
    ja: "取得済み",
    en: "Fetched: ",
  },
  "検索上限に達しました。範囲を狭めてください": {
    ja: "検索上限に達しました。範囲を狭めてください",
    en: "Search limit reached. Narrow the scope",
  },
  一部の検索に失敗しました: {
    ja: "一部の検索に失敗しました",
    en: "Some searches failed",
  },
  取得途中: {
    ja: "取得途中",
    en: "Partially Fetched",
  },
  "{0}/{1} 検索対象{2}": {
    ja: "{0}/{1} 検索対象{2}",
    en: "{0}/{1} searches{2}",
  },
  " · {0} 件省略": {
    ja: " · {0} 件省略",
    en: " · {0} omitted",
  },
  取得状況: {
    ja: "取得状況",
    en: "Fetch Status",
  },
  "取得済み {0} 件。{1}\n\n各検索は最大2ページ、全体で最大400件を保存します。取得済みの結果を新しい順に並べています。全範囲の最新400件を保証するものではありません。\n\n取得中の新着・編集・検索インデックスの変更でページ境界が動くため、重複を除いても一部の投稿を取得できない場合があります。必要なら範囲を狭めて先頭から更新してください。":
    {
      ja: "取得済み {0} 件。{1}\n\n各検索は最大2ページ、全体で最大400件を保存します。取得済みの結果を新しい順に並べています。全範囲の最新400件を保証するものではありません。\n\n取得中の新着・編集・検索インデックスの変更でページ境界が動くため、重複を除いても一部の投稿を取得できない場合があります。必要なら範囲を狭めて先頭から更新してください。",
      en: "Fetched {0} results. {1}\n\nEach search fetches up to 2 pages, with 400 results stored in total. Fetched results are sorted newest first; they may not be the newest 400 across the entire scope.\n\nNew messages, edits, and search indexing can shift page boundaries while fetching. Some messages may be missed even after deduplication. Narrow the scope and reload from the beginning if needed.",
    },
  "保存上限で {0} 件を省略しました。": {
    ja: "保存上限で {0} 件を省略しました。",
    en: "Omitted {0} results due to the storage limit.",
  },
  先頭から更新: {
    ja: "先頭から更新",
    en: "Reload from Beginning",
  },
  "プレビュー（⌘Rで全文を取得）\n\n{0}": {
    ja: "プレビュー（⌘Rで全文を取得）\n\n{0}",
    en: "Preview (⌘R to fetch the full message)\n\n{0}",
  },
  既読: {
    ja: "既読",
    en: "Read",
  },
  "スレッド返信（既読かどうかは判定しない）": {
    ja: "スレッド返信（既読かどうかは判定しない）",
    en: "Thread reply (read status not evaluated)",
  },
  "未確認（既読位置を取れていない）": {
    ja: "未確認（既読位置を取れていない）",
    en: "Unknown (read position unavailable)",
  },
  "開いた・対応済み": {
    ja: "開いた・対応済み",
    en: "Opened / Handled",
  },
  "Reply in Thread": {
    ja: "スレッドに返信",
    en: "Reply in Thread",
  },
  "Filter by This Conversation": {
    ja: "この会話で絞り込む",
    en: "Filter by This Conversation",
  },
  "Filter by Sender": {
    ja: "投稿者で絞り込む",
    en: "Filter by Sender",
  },
  "Open Permalink in Browser": {
    ja: "ブラウザで開く",
    en: "Open Permalink in Browser",
  },
  "Copy Permalink": {
    ja: "リンクをコピー",
    en: "Copy Permalink",
  },
  "View Channels with Sender": {
    ja: "投稿者がいるチャンネルを表示",
    en: "View Channels with Sender",
  },
  "View Channel Members": {
    ja: "チャンネルの参加者を表示",
    en: "View Channel Members",
  },
  公開チャンネル: {
    ja: "公開チャンネル",
    en: "Public Channel",
  },
  非公開チャンネル: {
    ja: "非公開チャンネル",
    en: "Private Channel",
  },
  人: {
    ja: "人",
    en: "Person",
  },
  種別: {
    ja: "種別",
    en: "Type",
  },
  ハンドル: {
    ja: "ハンドル",
    en: "Handle",
  },
  実名: {
    ja: "実名",
    en: "Real Name",
  },
  役職: {
    ja: "役職",
    en: "Job Title",
  },
  別名: {
    ja: "別名",
    en: "Aliases",
  },
  Refresh: {
    ja: "更新",
    en: "Refresh",
  },
  "#{0} の参加者": {
    ja: "#{0} の参加者",
    en: "Members of #{0}",
  },
  "名前・ハンドルで絞り込む": {
    ja: "名前・ハンドルで絞り込む",
    en: "Filter by name or handle",
  },
  参加者を取得中: {
    ja: "参加者を取得中",
    en: "Loading members",
  },
  参加者を取得できません: {
    ja: "参加者を取得できません",
    en: "Could not load members",
  },
  名前に一致する参加者がいません: {
    ja: "名前に一致する参加者がいません",
    en: "No members match this name",
  },
  参加者はいません: {
    ja: "参加者はいません",
    en: "No members",
  },
  "認証を確認し、Hubを開き直してください": {
    ja: "認証を確認し、Hubを開き直してください",
    en: "Check authentication and reopen Slack Hub",
  },
  "検索を一時停止しています（{0}まで）": {
    ja: "検索を一時停止しています（{0}まで）",
    en: "Search paused until {0}",
  },
  検索中: {
    ja: "検索中",
    en: "Searching",
  },
  このチャンネルに一致するメッセージがありません: {
    ja: "このチャンネルに一致するメッセージがありません",
    en: "No matching messages in this channel",
  },
  "#{0} 内を検索": {
    ja: "#{0} 内を検索",
    en: "Search in #{0}",
  },
  このチャンネル内のメッセージを検索: {
    ja: "このチャンネル内のメッセージを検索",
    en: "Search messages in this channel",
  },
  "検索先: #{0}": {
    ja: "検索先: #{0}",
    en: "Searching: #{0}",
  },
  参加関係の応答を読み取れませんでした: {
    ja: "参加関係の応答を読み取れませんでした",
    en: "Could not read the membership response",
  },
  参加関係の取得が時間切れになりました: {
    ja: "参加関係の取得が時間切れになりました",
    en: "Membership request timed out",
  },
  "Slackの認証を確認し、Hubを開き直してください": {
    ja: "Slackの認証を確認し、Hubを開き直してください",
    en: "Check Slack authentication and reopen Slack Hub",
  },
  参加者は重複なく1人から5人まで指定してください: {
    ja: "参加者は重複なく1人から5人まで指定してください",
    en: "Select between 1 and 5 distinct people",
  },
  "Slack APIの回数制限です。待ってからRefreshしてください": {
    ja: "Slack APIの回数制限です。待ってから「更新」してください",
    en: "Slack API rate limit. Wait before refreshing",
  },
  参加関係の取得に必要なSlackの権限がありません: {
    ja: "参加関係の取得に必要なSlackの権限がありません",
    en: "Missing Slack permissions to fetch memberships",
  },
  "参加関係を取得できませんでした。Refreshで再試行してください": {
    ja: "参加関係を取得できませんでした。「更新」で再試行してください",
    en: "Could not fetch memberships. Refresh to try again",
  },
  ボット: {
    ja: "ボット",
    en: "Bot",
  },
  状態未確認: {
    ja: "状態未確認",
    en: "Status Unknown",
  },
  "取得 {0}": {
    ja: "取得 {0}",
    en: "Fetched at {0}",
  },
  "前回取得 · ": {
    ja: "前回取得 · ",
    en: "Previous results · ",
  },
  "{0}更新中{1}": {
    ja: "{0}更新中{1}",
    en: "{0}Refreshing{1}",
  },
  "{0}{1} · {2}秒後に再試行{3}": {
    ja: "{0}{1} · {2}秒後に再試行{3}",
    en: "{0}{1} · Retry in {2} seconds{3}",
  },
  "認証設定を確認し、Hubを開き直してください": {
    ja: "認証設定を確認し、Hubを開き直してください",
    en: "Check authentication preferences and reopen Slack Hub",
  },
  "{0}件{1}": {
    ja: "{0}件{1}",
    en: "{0} results{1}",
  },
  自分: {
    ja: "自分",
    en: "You",
  },
  "全員が参加（{0}/{1}人）: {2}": {
    ja: "全員が参加（{0}/{1}人）: {2}",
    en: "Joined by Everyone ({0}/{1} people): {2}",
  },
  "Add Person": {
    ja: "人を追加",
    en: "Add Person",
  },
  "Remove Person": {
    ja: "人を外す",
    en: "Remove Person",
  },
  "Reset People": {
    ja: "選択をリセット",
    en: "Reset People",
  },
  参加チャンネル: {
    ja: "参加チャンネル",
    en: "Joined Channels",
  },
  "チャンネル名・別名で絞り込む": {
    ja: "チャンネル名・別名で絞り込む",
    en: "Filter by channel name or alias",
  },
  参加チャンネルを取得できません: {
    ja: "参加チャンネルを取得できません",
    en: "Could not load joined channels",
  },
  参加チャンネルを取得中: {
    ja: "参加チャンネルを取得中",
    en: "Loading joined channels",
  },
  名前に一致するチャンネルがありません: {
    ja: "名前に一致するチャンネルがありません",
    en: "No channels match this name",
  },
  この条件のチャンネルはありません: {
    ja: "この条件のチャンネルはありません",
    en: "No channels match these filters",
  },
  "{0}\n公開チャンネルと、自分も参加する非公開チャンネル（アーカイブ除外）\n{1}":
    {
      ja: "{0}\n公開チャンネルと、自分も参加する非公開チャンネル（アーカイブ除外）\n{1}",
      en: "{0}\nPublic channels and private channels you have joined (excluding archived channels)\n{1}",
    },
  "公開・自分も参加する非公開（アーカイブ除外） · {0}": {
    ja: "公開・自分も参加する非公開（アーカイブ除外） · {0}",
    en: "Public channels and private channels you have joined (excluding archived) · {0}",
  },
  "Search in This Conversation": {
    ja: "この会話内を検索",
    en: "Search in This Conversation",
  },
  名前で検索: {
    ja: "名前で検索",
    en: "Search by name",
  },
  該当する人がいません: {
    ja: "該当する人がいません",
    en: "No matching people",
  },
  置き換えを追加: {
    ja: "置き換えを追加",
    en: "Add Replacement",
  },
  Add: {
    ja: "追加",
    en: "Add",
  },
  置き換える語を入れてください: {
    ja: "置き換える語を入れてください",
    en: "Enter the text to replace",
  },
  チャンネル名の語: {
    ja: "チャンネル名の語",
    en: "Channel Name Text",
  },
  ドキュメント: {
    ja: "ドキュメント",
    en: "Documents",
  },
  自分の呼び方: {
    ja: "自分の呼び方",
    en: "Your Replacement",
  },
  "チャンネル名やグループDMの名前に含まれる語を置き換えた名前でも、検索に当たるようになります。例: ドキュメント → docsで、docsからドキュメントの名前を探せます":
    {
      ja: "チャンネル名やグループDMの名前に含まれる語を置き換えた名前でも、検索に当たるようになります。例: ドキュメント → docsで、docsからドキュメントの名前を探せます",
      en: "Match channel and group DM names using alternative text. Example: replacing documents → docs lets you find a documents channel by searching for docs",
    },
  "Add Rule": {
    ja: "置き換えを追加",
    en: "Add Rule",
  },
  名前の置き換え辞書: {
    ja: "名前の置き換え辞書",
    en: "Name Replacement Dictionary",
  },
  置き換えはまだありません: {
    ja: "置き換えはまだありません",
    en: "No replacements yet",
  },
  "ActionsのAdd Ruleで追加します（例: ドキュメント → docs）": {
    ja: "Actionsの「置き換えを追加」で追加します（例: ドキュメント → docs）",
    en: "Use Add Rule in Actions (example: documents → docs)",
  },
  "Delete Rule": {
    ja: "置き換えを削除",
    en: "Delete Rule",
  },
  "{0} → {1} を消しますか": {
    ja: "{0} → {1} を消しますか",
    en: "Delete {0} → {1}?",
  },
  Delete: {
    ja: "削除",
    en: "Delete",
  },
  "{0} の別名": {
    ja: "{0} の別名",
    en: "Aliases for {0}",
  },
  Save: {
    ja: "保存",
    en: "Save",
  },
  "分報, times": {
    ja: "分報, times",
    en: "updates, times",
  },
  "この名前でも検索に当たるようになります。空にすると別名を消します": {
    ja: "この名前でも検索に当たるようになります。空にすると別名を消します",
    en: "This name will also match in search. Leave empty to remove aliases",
  },
  設定ファイルを読めませんでした: {
    ja: "設定ファイルを読めませんでした",
    en: "Could not read the preferences file",
  },
  "この回は空の設定で動き、変更は保存しません（{0}）": {
    ja: "この回は空の設定で動き、変更は保存しません（{0}）",
    en: "Using empty preferences for this session; changes will not be saved ({0})",
  },
  設定ファイルが壊れていました: {
    ja: "設定ファイルが壊れていました",
    en: "The preferences file was corrupted",
  },
  "{0} に退避して、空の設定で始めました": {
    ja: "{0} に退避して、空の設定で始めました",
    en: "Backed up to {0} and started with empty preferences",
  },
  設定ファイルが壊れています: {
    ja: "設定ファイルが壊れています",
    en: "The preferences file is corrupted",
  },
  "退避できなかったので、この回は空の設定で動き、変更は保存しません（{0}）": {
    ja: "退避できなかったので、この回は空の設定で動き、変更は保存しません（{0}）",
    en: "Could not create a backup. Using empty preferences without saving changes ({0})",
  },
  "prefs.json を読めませんでした（{0}）。この回は空の設定で動き、保存しません":
    {
      ja: "prefs.json を読めませんでした（{0}）。この回は空の設定で動き、保存しません",
      en: "Could not read prefs.json ({0}). Using empty preferences without saving changes",
    },
  "prefs.json が壊れていますが、退避できませんでした（{0}）。この回は空の設定で動き、保存しません":
    {
      ja: "prefs.json が壊れていますが、退避できませんでした（{0}）。この回は空の設定で動き、保存しません",
      en: "prefs.json is corrupted and could not be backed up ({0}). Using empty preferences without saving changes",
    },
  "prefs.json が壊れていたので、{0} に退避して、空の設定で始めました": {
    ja: "prefs.json が壊れていたので、{0} に退避して、空の設定で始めました",
    en: "prefs.json was corrupted. Backed up to {0} and started with empty preferences",
  },
  AI未判定: {
    ja: "AI未判定",
    en: "Not Assessed by AI",
  },
  期限が近い可能性: {
    ja: "期限が近い可能性",
    en: "Deadline May Be Near",
  },
  作業が止まっている可能性: {
    ja: "作業が止まっている可能性",
    en: "Work May Be Blocked",
  },
  催促ありの可能性: {
    ja: "催促ありの可能性",
    en: "Possible Reminder",
  },
  期限を要確認: {
    ja: "期限を要確認",
    en: "Check Deadline",
  },
  会話の取得が不完全: {
    ja: "会話の取得が不完全",
    en: "Conversation Context Is Incomplete",
  },
  キャッシュ索引が不正です: {
    ja: "キャッシュ索引が不正です",
    en: "Invalid cache index",
  },
  取得予算の時間切れです: {
    ja: "取得予算の時間切れです",
    en: "Fetch time budget exceeded",
  },
  スキャンは一度だけ開始できます: {
    ja: "スキャンは一度だけ開始できます",
    en: "A scan can only be started once",
  },
  "{0}{1}時間{2}": {
    ja: "{0}{1}時間{2}",
    en: "{0}{1} hours{2}",
  },
  "待ち時間の下限 ": {
    ja: "待ち時間の下限 ",
    en: "Waiting at least ",
  },
  "待ち時間 ": {
    ja: "待ち時間 ",
    en: "Waiting ",
  },
  以上: {
    ja: "以上",
    en: " or more",
  },
  "確認待ち・{0}": {
    ja: "確認待ち・{0}",
    en: "Needs Review · {0}",
  },
  取得時点では後続の自分の投稿なし: {
    ja: "取得時点では後続の自分の投稿なし",
    en: "No later message from you at the time of fetching",
  },
  投稿者: {
    ja: "投稿者",
    en: "Sender",
  },
  AI判定失敗: {
    ja: "AI判定失敗",
    en: "AI Assessment Failed",
  },
  "\n\n{0}\n\n必要性 {1} · 時間 {2}/3 · 業務停止 {3}/2 · {4} / {5}": {
    ja: "\n\n{0}\n\n必要性 {1} · 時間 {2}/3 · 業務停止 {3}/2 · {4} / {5}",
    en: "\n\n{0}\n\nReply needed {1} · Deadline {2}/3 · Blocking {3}/2 · {4} / {5}",
  },
  "除外・延期を取り消す": {
    ja: "除外・延期を取り消す",
    en: "Undo Dismissal or Snooze",
  },
  返信不要: {
    ja: "返信不要",
    en: "No Reply Needed",
  },
  "あとで対応・1時間": {
    ja: "あとで対応・1時間",
    en: "Snooze for 1 Hour",
  },
  "あとで対応・翌朝9時": {
    ja: "あとで対応・翌朝9時",
    en: "Snooze until Tomorrow at 9 AM",
  },
  "認証設定が変わりました。Slack Hubを開き直してください。": {
    ja: "認証設定が変わりました。Slack Hubを開き直してください。",
    en: "Authentication preferences changed. Reopen Slack Hub.",
  },
  要確認: {
    ja: "要確認",
    en: "Needs Review",
  },
  優先候補: {
    ja: "優先候補",
    en: "Priority Candidates",
  },
  返信不要の可能性: {
    ja: "返信不要の可能性",
    en: "Reply May Be Unnecessary",
  },
  未返信候補: {
    ja: "未返信候補",
    en: "Unanswered Candidates",
  },
  "除外・あとで対応": {
    ja: "除外・あとで対応",
    en: "Dismissed / Snoozed",
  },
  お気に入りチャンネル: {
    ja: "お気に入りチャンネル",
    en: "Favorite Channels",
  },
  削除されたセクション: {
    ja: "削除されたセクション",
    en: "Deleted Section",
  },
  "{0}までAI判定を停止します": {
    ja: "{0}までAI判定を停止します",
    en: "AI assessment paused until {0}",
  },
  "TypeSafe API Keyを設定してください。AIなしでも候補を確認できます": {
    ja: "TypeSafe API Keyを設定してください。AIなしでも候補を確認できます",
    en: "Set your TypeSafe API Key. You can review candidates without AI",
  },
  "TypeSafeへ会話本文を送信しますか？": {
    ja: "TypeSafeへ会話本文を送信しますか？",
    en: "Send conversation text to TypeSafe?",
  },
  "選択した投稿者以外の発言も会話の文脈として送ります。表示候補の本文・投稿時刻・相対化した投稿者情報をTypeSafeへ送信します。本文に含まれる個人情報は自動では除去しません。1回最大20候補です。Slackトークンは送りません。無効化で今後の送信は止まりますが、送信済み本文は取り消せません。":
    {
      ja: "選択した投稿者以外の発言も会話の文脈として送ります。表示候補の本文・投稿時刻・相対化した投稿者情報をTypeSafeへ送信します。本文に含まれる個人情報は自動では除去しません。1回最大20候補です。Slackトークンは送りません。無効化で今後の送信は止まりますが、送信済み本文は取り消せません。",
      en: "Messages from other senders are included as conversation context. Candidate text, posting times, and relative sender identities will be sent to TypeSafe. Personal information in the text is not removed automatically. Up to 20 candidates per round. Slack tokens are not sent. Disabling AI stops future sending but cannot undo text already sent.",
    },
  有効にして判定: {
    ja: "有効にして判定",
    en: "Enable and Assess",
  },
  AIなしで確認: {
    ja: "AIなしで確認",
    en: "Review without AI",
  },
  "TypeSafeの認証に失敗しました。設定のAPI Keyを確認・更新してからSlack Hubを開き直してください":
    {
      ja: "TypeSafeの認証に失敗しました。設定のAPI Keyを確認・更新してからSlack Hubを開き直してください",
      en: "TypeSafe authentication failed. Check or update the API Key in preferences and reopen Slack Hub",
    },
  "AIの回数制限に当たりました。候補は残っています": {
    ja: "AIの回数制限に当たりました。候補は残っています",
    en: "AI rate limit reached. Candidates are still available",
  },
  "未判定 {0}件。次の判定で続きます": {
    ja: "未判定 {0}件。次の判定で続きます",
    en: "{0} candidates remain unassessed. Continue in the next round",
  },
  "AI判定できませんでした。再試行できます": {
    ja: "AI判定できませんでした。再試行できます",
    en: "AI assessment failed. You can try again",
  },
  AI判定を反映すると順序を更新します: {
    ja: "AI判定を反映すると順序を更新します",
    en: "Applying AI results updates the order",
  },
  "AI判定できませんでした。候補は残っています": {
    ja: "AI判定できませんでした。候補は残っています",
    en: "AI assessment failed. Candidates are still available",
  },
  Slackの回数制限で停止中です: {
    ja: "Slackの回数制限で停止中です",
    en: "Paused due to Slack rate limiting",
  },
  自分の後続投稿が見つかりました: {
    ja: "自分の後続投稿が見つかりました",
    en: "Found a later message from you",
  },
  一覧を更新してから確認してください: {
    ja: "一覧を更新してから確認してください",
    en: "Refresh the list before checking again",
  },
  "前回の確認。最新状態を確認できませんでした。\n": {
    ja: "前回の確認。最新状態を確認できませんでした。\n",
    en: "Previous check. Could not verify the current state.\n",
  },
  "フォームを開く直前に確認しました。\n": {
    ja: "フォームを開く直前に確認しました。\n",
    en: "Checked just before opening the form.\n",
  },
  "取得済み {0}件。省略 {1}件。未処理 {2}件。{3}{4}\n\n検索は1回4呼び出し、100件×2ページ、候補400件を上限にします。Slackの検索ページは新着・編集で境界が動き、欠落ゼロを保証しません。":
    {
      ja: "取得済み {0}件。省略 {1}件。未処理 {2}件。{3}{4}\n\n検索は1回4呼び出し、100件×2ページ、候補400件を上限にします。Slackの検索ページは新着・編集で境界が動き、欠落ゼロを保証しません。",
      en: "Fetched {0}. Omitted {1}. Pending {2}. {3}{4}\n\nEach round allows 4 search calls, 100 results × 2 pages, and up to 400 candidates. Slack search page boundaries can shift after new posts or edits, so some messages may be missed.",
    },
  "表示・ページ上限あり。範囲を狭めてください。": {
    ja: "表示・ページ上限あり。範囲を狭めてください。",
    en: "Display or page limit reached. Narrow the scope. ",
  },
  "一部取得できませんでした。": {
    ja: "一部取得できませんでした。",
    en: "Some results could not be fetched.",
  },
  "Reload Reply Candidates": {
    ja: "返信待ちを更新",
    en: "Reload Reply Candidates",
  },
  続きを確認: {
    ja: "続きを確認",
    en: "Continue Checking",
  },
  "{0}以降に「続きを確認」を実行してください": {
    ja: "{0}以降に「続きを確認」を実行してください",
    en: "Use Continue Checking after {0}",
  },
  過去24時間: {
    ja: "過去24時間",
    en: "Past 24 Hours",
  },
  過去7日: {
    ja: "過去7日",
    en: "Past 7 Days",
  },
  AI判定を中断: {
    ja: "AI判定を中断",
    en: "Stop AI Assessment",
  },
  "AIで並べる・再試行": {
    ja: "AIで並べる・再試行",
    en: "Sort with AI / Retry",
  },
  "AI判定を中断しました。再試行できます": {
    ja: "AI判定を中断しました。再試行できます",
    en: "AI assessment stopped. You can try again",
  },
  AI判定を反映: {
    ja: "AI判定を反映",
    en: "Apply AI Results",
  },
  "判定が古くなりました。更新してから再判定してください": {
    ja: "判定が古くなりました。更新してから再判定してください",
    en: "The assessment is stale. Refresh and assess again",
  },
  AIを無効にする: {
    ja: "AIを無効にする",
    en: "Disable AI",
  },
  "認証設定が変わりました。Slack Hubを開き直してください": {
    ja: "認証設定が変わりました。Slack Hubを開き直してください",
    en: "Authentication preferences changed. Reopen Slack Hub",
  },
  "認証が確定していないため取得できません。Slack Hubを開き直してください": {
    ja: "認証が確定していないため取得できません。Slack Hubを開き直してください",
    en: "Authentication is not confirmed. Reopen Slack Hub before fetching",
  },
  検索条件を選び直してください: {
    ja: "検索条件を選び直してください",
    en: "Choose search filters again",
  },
  "{0}件の参照できないチャンネルを除外しました。ディレクトリを更新してください":
    {
      ja: "{0}件の参照できないチャンネルを除外しました。ディレクトリを更新してください",
      en: "Excluded {0} unavailable channels. Refresh the directory",
    },
  "Slackの回数制限。{0}以降に「続きを確認」": {
    ja: "Slackの回数制限。{0}以降に「続きを確認」",
    en: "Slack rate limit. Continue Checking after {0}",
  },
  "AIの回数制限。{0}以降に「AIで並べる・再試行」": {
    ja: "AIの回数制限。{0}以降に「AIで並べる・再試行」",
    en: "AI rate limit. Sort with AI / Retry after {0}",
  },
  "返信待ち / {0}{1}": {
    ja: "返信待ち / {0}{1}",
    en: "Awaiting Reply / {0}{1}",
  },
  返信待ちを検索: {
    ja: "返信待ちを検索",
    en: "Search reply candidates",
  },
  返信待ちの表示: {
    ja: "返信待ちの表示",
    en: "Reply Candidate Filter",
  },
  すべての候補: {
    ja: "すべての候補",
    en: "All Candidates",
  },
  "{0} {1}件": {
    ja: "{0} {1}件",
    en: "{0} · {1} candidates",
  },
  返信待ち候補はありません: {
    ja: "返信待ち候補はありません",
    en: "No reply candidates",
  },
  認証設定が変わりました: {
    ja: "認証設定が変わりました",
    en: "Authentication preferences changed",
  },
  "検索に失敗しました。続きを取得で再試行できます": {
    ja: "検索に失敗しました。続きを取得で再試行できます",
    en: "Search failed. Use Continue Search to try again",
  },
  "{0}が時間切れになりました": {
    ja: "{0}が時間切れになりました",
    en: "{0} timed out",
  },
  "Slack APIへの問い合わせに失敗しました": {
    ja: "Slack APIへの問い合わせに失敗しました",
    en: "Slack API request failed",
  },
  検索: {
    ja: "検索",
    en: "Search",
  },
  既読位置の取得: {
    ja: "既読位置の取得",
    en: "Read Position Request",
  },
  条件検索: {
    ja: "条件検索",
    en: "Filtered Search",
  },
  "検索に失敗しました。更新して再試行してください": {
    ja: "検索に失敗しました。更新して再試行してください",
    en: "Search failed. Refresh to try again",
  },
  参照できないチャンネル: {
    ja: "参照できないチャンネル",
    en: "Unavailable Channel",
  },
  指定投稿者: {
    ja: "指定投稿者",
    en: "Selected Sender",
  },
  セクションを選び直してください: {
    ja: "セクションを選び直してください",
    en: "Choose a section again",
  },
  チャンネルを選び直してください: {
    ja: "チャンネルを選び直してください",
    en: "Choose a channel again",
  },
  投稿者を選び直してください: {
    ja: "投稿者を選び直してください",
    en: "Choose a sender again",
  },
  範囲または投稿者を指定してください: {
    ja: "範囲または投稿者を指定してください",
    en: "Select a scope or sender",
  },
  適用: {
    ja: "適用",
    en: "Apply",
  },
  メッセージを表示: {
    ja: "メッセージを表示",
    en: "Show Messages",
  },
  条件をクリアして適用: {
    ja: "条件をクリアして適用",
    en: "Clear Filters and Apply",
  },
  検索範囲: {
    ja: "検索範囲",
    en: "Search Scope",
  },
  セクション: {
    ja: "セクション",
    en: "Section",
  },
  選択したセクションは削除されています: {
    ja: "選択したセクションは削除されています",
    en: "The selected section was deleted",
  },
  セクションを選んでください: {
    ja: "セクションを選んでください",
    en: "Choose a section",
  },
  指定なし: {
    ja: "指定なし",
    en: "None",
  },
  "範囲内の投稿と投稿者の両方に一致するメッセージを探します。適用するまで検索は始まりません。":
    {
      ja: "範囲内の投稿と投稿者の両方に一致するメッセージを探します。適用するまで検索は始まりません。",
      en: "Find messages matching both the scope and sender. Search starts only after applying the filters.",
    },
  検索条件のIDが不正です: {
    ja: "検索条件のIDが不正です",
    en: "Invalid search filter ID",
  },
  "複数のin/from条件は選択条件と併用できません": {
    ja: "複数のin/from条件は選択条件と併用できません",
    en: "Multiple in/from filters cannot be combined with selected filters",
  },
  括弧またはORの条件を修正してください: {
    ja: "括弧またはORの条件を修正してください",
    en: "Change the parentheses or OR conditions",
  },
  "in/from条件の対象を確定してください": {
    ja: "in/from条件の対象を確定してください",
    en: "Resolve the target of the in/from filter",
  },
  "in/from条件の値を指定してください": {
    ja: "in/from条件の値を指定してください",
    en: "Enter a value for the in/from filter",
  },
  "in/from条件を安全に解釈できません": {
    ja: "in/from条件を安全に解釈できません",
    en: "Could not safely interpret the in/from filter",
  },
  検索計画の条件が不正です: {
    ja: "検索計画の条件が不正です",
    en: "Invalid search plan filters",
  },
  検索を中断しました: {
    ja: "検索を中断しました",
    en: "Search cancelled",
  },
  "{0}を取得できませんでした": {
    ja: "{0}を取得できませんでした",
    en: "Could not fetch {0}",
  },
  "Slack への問い合わせが時間切れでした": {
    ja: "Slack への問い合わせが時間切れでした",
    en: "Slack request timed out",
  },
  "{0} まで{1}の取得を止めます（そのあと、Reload Searchで取り直せます）": {
    ja: "{0} まで{1}の取得を止めます（そのあと、「検索を更新」で取り直せます）",
    en: "Fetching {1} is paused until {0}. Use Reload Search afterwards",
  },
  自分宛て: {
    ja: "メンション・DM",
    en: "Mentions & DMs",
  },
  既読位置: {
    ja: "既読位置",
    en: "Read Position",
  },
  お気に入りの未読: {
    ja: "お気に入りの未読",
    en: "Unread Favorites",
  },
  "Show Details": {
    ja: "詳細を表示",
    en: "Show Details",
  },
  "Mark as Handled": {
    ja: "対応済みにする",
    en: "Mark as Handled",
  },
  "Unmark as Handled": {
    ja: "対応済みを解除",
    en: "Unmark as Handled",
  },
  "Filter by This Person": {
    ja: "この人で絞り込む",
    en: "Filter by This Person",
  },
  "Remove from Favorites": {
    ja: "お気に入りから外す",
    en: "Remove from Favorites",
  },
  "Add to Favorites": {
    ja: "お気に入りに追加",
    en: "Add to Favorites",
  },
  ユーザー: {
    ja: "ユーザー",
    en: "People",
  },
  グループDM一覧: {
    ja: "グループDM",
    en: "Group DMs",
  },
  "チャンネル・人・メッセージを検索": {
    ja: "チャンネル・人・メッセージを検索",
    en: "Search Slack",
  },
  "{0}{1}月{2}日（{3}）{4}": {
    ja: "{0}{1}月{2}日（{3}）{4}",
    en: "{0}{1}/{2} ({3}) {4}",
  },
  "{0}年": { ja: "{0}年", en: "{0} " },
  過去の投稿を取得中: {
    ja: "過去の投稿を取得中",
    en: "Loading earlier messages",
  },
  "過去の投稿には履歴権限が必要です。設定を確認してください": {
    ja: "過去の投稿には履歴権限が必要です。設定を確認してください",
    en: "History permissions are required for earlier messages. Check your settings",
  },
  "Slackの回数制限です。{0}以降に詳細を更新してください": {
    ja: "Slackの回数制限です。{0}以降に詳細を更新してください",
    en: "Slack rate limit. Refresh details after {0}",
  },
  "この投稿のスレッドを取得できません。Slackで確認してください": {
    ja: "この投稿のスレッドを取得できません。Slackで確認してください",
    en: "This thread is unavailable. Check it in Slack",
  },
  "過去の投稿を取得できませんでした。詳細を更新してください": {
    ja: "過去の投稿を取得できませんでした。詳細を更新してください",
    en: "Could not load earlier messages. Refresh details to retry",
  },
  "取得上限に達しました。続きはSlackで確認してください": {
    ja: "取得上限に達しました。続きはSlackで確認してください",
    en: "Fetch limit reached. Read the rest in Slack",
  },
  "取得途中です。直前の投稿がまだ含まれない場合があります": {
    ja: "取得途中です。直前の投稿がまだ含まれない場合があります",
    en: "More messages remain. Recent context may not be included yet",
  },
  選択したメッセージ: { ja: "選択したメッセージ", en: "Selected message" },
  スレッドの親投稿: { ja: "スレッドの親投稿", en: "Thread parent" },
  過去の投稿をさらに取得: {
    ja: "過去の投稿をさらに取得",
    en: "Load More Earlier Messages",
  },
  詳細を更新: { ja: "詳細を更新", en: "Refresh Details" },
} as const;
