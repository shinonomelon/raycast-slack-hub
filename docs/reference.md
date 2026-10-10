# 設定・保存データ・トラブル対応

[READMEへ戻る](../README.md)

## APIと必要な権限

Slackアプリに許可する操作をスコープと呼びます。使うAPIごとに、次の権限が必要です。

| 機能                                     | 公式API                                          | User Token Scope                                                                       |
| ---------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 自分とワークスペースの確認               | `auth.test`                                      | 追加スコープ不要                                                                       |
| 公開・非公開チャンネル、グループDMの一覧 | `conversations.list`                             | `channels:read`・`groups:read`・`mpim:read`                                            |
| 参加中の公開チャンネル                   | `users.conversations`                            | `channels:read`                                                                        |
| 人の参加チャンネル・全員の共通チャンネル | `users.conversations`                            | `channels:read`・`groups:read`                                                         |
| チャンネルの参加者                       | `conversations.members`                          | `channels:read`・`groups:read`                                                         |
| 人の一覧                                 | `users.list`                                     | `users:read`                                                                           |
| メッセージ検索、自分宛て                 | `search.messages`                                | `search:read`                                                                          |
| 既読位置                                 | `conversations.info`                             | `channels:read`・`groups:read`・`im:read`・`mpim:read`（会話の種類による）             |
| 投稿、スレッド返信                       | `chat.postMessage`                               | `chat:write`                                                                           |
| 返信待ちの会話・スレッド確認             | `conversations.history`・`conversations.replies` | `im:history`・`channels:history`・`groups:history`・`mpim:history`（会話の種類による） |
| 人へのDMの開始                           | `conversations.open`                             | `im:write`                                                                             |

スコープを追加したらアプリを再インストールし、トークンが変わった場合はRaycastの設定も更新します。メールアドレスを取得しないので`users:read.email`は不要です。

## 保存するデータ

| 保存先                                           | 内容                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Raycastのpassword設定                            | User OAuth Tokenと任意のTypeSafe APIキー。各サービスの通信にだけ渡し、ログやキャッシュには保存しません                     |
| RaycastのCache（ワークスペースID・ユーザーID別） | 会話・人の一覧、参加中の公開チャンネル、既読位置、行を開いた時刻、対応済みの印、自分宛ての前回結果、お気に入りの未読の目安 |
| 認証用Cache                                      | `auth.test`の結果。キーはトークンのハッシュで、生のトークンは含みません                                                    |
| 共通Cache                                        | 検索を止める期限、よく開く順の記録                                                                                         |
| 拡張の`prefs.json`                               | お気に入り、別名、置き換え辞書、参加中の絞り込み                                                                           |

Cacheと保存ファイルは`~/Library/Application Support/com.raycast.macos/extensions/slack-hub/`配下にあります。Cacheは暗号化されません。自分宛ての前回結果には本文の先頭300字までが含まれます。お気に入りの未読結果には本文を保存しません。

返信待ちでは候補本文・履歴確認・続きの取得位置・AI結果を5分保存します。除外・延期の印は14日で破棄します。期限切れは読み込み時に削除します。期間や認証設定が変わった場合は以前の結果を使いません。[返信待ちの使い方](reply-priority.md)も参照してください。

人の参加チャンネルとチャンネル参加者はメモリ内で2分間再利用します。認証クライアントと本人ごとに分け、完全に取得した結果だけを保存します。Refreshでは再利用せず取り直します。

投稿本文はメモリ内でMarkdownからBlock Kitと通知用textへ変換します。投稿用の一時ファイルや外部プロセスは使いません。旧版のCLI設定・鍵・一時ファイルは自動削除しません。

初回は空のお気に入り・別名・辞書から始めます。他の拡張の設定や、アカウントを特定できない古いキャッシュは読み込みません。現在のSlack Hub自身の設定と、アカウント別キャッシュは引き続き使います。

## 更新と削除

更新は拡張のリポジトリだけで行います。

```bash
cd ~/raycast-slack-hub
git pull --ff-only
npm ci
npm run dev
```

取り込みが終わったらControl+Cで止めます。Raycastの設定は更新しても残ります。

削除する場合はRaycastの設定→ExtensionsでSlack Hubをアンインストールします。ソースのフォルダも削除できます。拡張の保存フォルダが残っている場合、削除すると設定・Cacheと旧版の保存データが消えます。トークンを失効させる場合は[Slackのアプリ管理画面](https://api.slack.com/apps)でアプリのトークンを取り消すか、不要なアプリを削除します。

## 困ったとき

- **トークン未設定／認証失敗**：Slack Access Tokenに自分のUser OAuth Tokenを入力し、Slack Hubを開き直します。`invalid_auth`・`not_authed`・`token_revoked`・`token_expired`・`account_inactive`ならトークンやアカウントの状態を確認します。以前の結果があれば保存済みの一覧を表示しますが、認証が成功するまで新しい取得と投稿は止めます。
- **`missing_scope`**：表示された必要な権限をUser Token Scopesに追加し、アプリを再インストールします。トークンが変わった場合はRaycastの設定も更新します。
- **回数制限／検索の時間切れ**：表示された待機期間の後にActionsのReload Searchで取り直します。429応答ではRetry-Afterを使い、そのAPIメソッドへの問い合わせを止めます。投稿は自動再試行しません。
- **「送れたか未確認です」**：投稿が届いている可能性があります。トーストのOpen Conversation／Open Parent MessageでSlackを開き、届いたかを確認してください。再送すると同じ投稿が二重になることがあります。
- **既読の位置が分からない**：Slackの応答に`last_read`がない会話は既読不明として扱います。取得失敗を未読ゼロとして表示しません。

解決しない場合は[GitHub Issues](https://github.com/shinonomelon/raycast-slack-hub/issues)に、操作手順と画面のエラーを報告してください。トークン・実際の本文・非公開の会話名は含めないでください。

## 開発する

テスト・ビルド・コードの配置は[開発手順](development.md)を参照してください。

## 旧版の保存データ

Slack Drafts、履歴・リアクションの検証待ち画面、ブックマーク・Listsのコードは削除しています。既存の`drafts.json`などは自動で削除せず、この版では読み込みません。保存フォルダを丸ごと削除すると、お気に入りや対応済みの印も失われます。

返信待ち・Jevは開発版に復元しています。旧キー設定が残っていても自動送信しません。保存結果は認証・期間・モデル・判定文と期限を照合して使います。残る検証は[対応予定](roadmap.md)で確認できます。
