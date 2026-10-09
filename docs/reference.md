# 設定・保存データ・トラブル対応

[READMEへ戻る](../README.md)

## APIと必要な権限

Slackアプリに許可する操作をスコープと呼びます。使うAPIごとに、次の権限が必要です。

| 機能                                     | 公式API               | User Token Scope                                                           |
| ---------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| 自分とワークスペースの確認               | `auth.test`           | 追加スコープ不要                                                           |
| 公開・非公開チャンネル、グループDMの一覧 | `conversations.list`  | `channels:read`・`groups:read`・`mpim:read`                                |
| 参加中の公開チャンネル                   | `users.conversations` | `channels:read`                                                            |
| 人の参加チャンネル・全員の共通チャンネル | `users.conversations` | `channels:read`・`groups:read` |
| チャンネルの参加者 | `conversations.members` | `channels:read`・`groups:read` |
| 人の一覧                                 | `users.list`          | `users:read`                                                               |
| メッセージ検索、自分宛て                 | `search.messages`     | `search:read`                                                              |
| 既読位置                                 | `conversations.info`  | `channels:read`・`groups:read`・`im:read`・`mpim:read`（会話の種類による） |
| 投稿、スレッド返信                       | `chat.postMessage`    | `chat:write`                                                               |
| 人へのDMの開始                           | `conversations.open`  | `im:write`                                                                 |

スコープを追加したらアプリを再インストールし、トークンが変わった場合はRaycastの設定も更新します。メールアドレスを取得しないので`users:read.email`は不要です。

## 保存するデータ

| 保存先                                           | 内容                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Raycastのpassword設定                            | User OAuth Token。通信のAuthorizationヘッダーにだけ渡し、ログやキャッシュには保存しません                                  |
| RaycastのCache（ワークスペースID・ユーザーID別） | 会話・人の一覧、参加中の公開チャンネル、既読位置、行を開いた時刻、対応済みの印、自分宛ての前回結果、お気に入りの未読の目安 |
| 認証用Cache                                      | `auth.test`の結果。キーはトークンのハッシュで、生のトークンは含みません                                                    |
| 共通Cache                                        | 検索を止める期限、よく開く順の記録                                                                                         |
| 拡張の`prefs.json`                               | お気に入り、別名、置き換え辞書、参加中の絞り込み                                                                           |
| 以前の`drafts.json`                              | 下書きの控え。暗号化しません。保存から30日で期限切れになります                                                             |
| `drafts.json.broken-…`                           | 壊れた控えの退避ファイル。自動削除しません                                                                                 |

Cacheと保存ファイルは`~/Library/Application Support/com.raycast.macos/extensions/slack-hub/`配下にあります。Cacheは暗号化されません。自分宛ての前回結果には本文の先頭300字までが含まれます。お気に入りの未読結果には本文を保存しません。

投稿本文はメモリ内でMarkdownからBlock Kitと通知用textへ変換します。投稿用の一時ファイルや外部プロセスは使いません。旧版のCLI設定・鍵・一時ファイルは自動削除しません。

初回は空のお気に入り・別名・辞書から始めます。他の拡張の設定や、アカウントを特定できない古いキャッシュは読み込みません。現在のSlack Hub自身の設定と、アカウント別キャッシュは引き続き使います。

## 更新と削除

更新は拡張のリポジトリだけで行います。

```bash
cd ~/raycast-slack-hub
git pull
npm ci
npm run dev
```

取り込みが終わったらControl+Cで止めます。Raycastの設定は更新しても残ります。

削除する場合はRaycastの設定→ExtensionsでSlack Hubをアンインストールします。ソースのフォルダも削除できます。拡張の保存フォルダが残っている場合、削除すると控え・設定・Cacheが消えます。トークンを失効させる場合は[Slackのアプリ管理画面](https://api.slack.com/apps)でアプリのトークンを取り消すか、不要なアプリを削除します。

## 困ったとき

- **トークン未設定／認証失敗**：Slack Access Tokenに自分のUser OAuth Tokenを入力し、Slack Hubを開き直します。`invalid_auth`・`not_authed`・`token_revoked`・`token_expired`・`account_inactive`ならトークンやアカウントの状態を確認します。以前の結果があれば保存済みの一覧を表示しますが、認証が成功するまで新しい取得と投稿は止めます。
- **`missing_scope`**：表示された必要な権限をUser Token Scopesに追加し、アプリを再インストールします。トークンが変わった場合はRaycastの設定も更新します。
- **回数制限／検索の時間切れ**：表示された待機期間の後にActionsのReload Searchで取り直します。429応答ではRetry-Afterを使い、そのAPIメソッドへの問い合わせを止めます。投稿は自動再試行しません。
- **「送れたか未確認です」**：投稿が届いている可能性があります。トーストのOpen Conversation／Open Parent MessageでSlackを開き、届いたかを確認してください。再送すると同じ投稿が二重になることがあります。
- **既読の位置が分からない**：Slackの応答に`last_read`がない会話は既読不明として扱います。取得失敗を未読ゼロとして表示しません。

解決しない場合は[GitHub Issues](https://github.com/shinonomelon/raycast-slack-hub/issues)に、操作手順と画面のエラーを報告してください。トークン・実際の本文・非公開の会話名は含めないでください。

## 開発時の検証

```bash
npm ci
npm test
npx tsc --noEmit
npm run lint
npm run build
```

API通信は架空のデータとHTTPモックで検証します。ページ送り、認証、429、検索の中断、既読位置、DMの開始、投稿の成功・失敗・未確認を扱います。テストは実際のSlackに投稿しません。GitHub ActionsはUTC・Asia/Tokyo・America/New_Yorkでテストします。

## 参加関係の取得

参加チャンネルと参加者は全ページを取得してから表示します。複数人の場合は全員の参加チャンネルIDの共通部分を使います。ページ途中の失敗は完全な結果として保存しません。操作全体の上限は30秒で、失敗時の自動再試行はしません。

新しい参加関係はメモリだけに保持し、ディスクへ保存しません。キャッシュの有効期間は2分、最大20エントリかつ合計10,000IDです。アカウントとAPIクライアントごとに隔離します。上限を超える単独の結果も表示できますが、キャッシュには残しません。

公開チャンネルと、自分も参加している非公開チャンネルを取得対象とします。権限・ゲスト・Slack Connect等によりAPIで見える範囲が異なる場合があります。表示した取得時刻以後の参加・退出はRefreshで確認してください。
