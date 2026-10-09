# Slack Hub

RaycastからSlackのチャンネル・人・グループDMを探し、メッセージの検索・投稿・スレッド返信ができる拡張です。公式Slack Web APIへ直接接続するため、slack-cliは不要です。

名前のファジー検索、お気に入り、別名、自分宛てのメッセージ整理にも対応しています。Raycast Storeには未公開です。

## インストールする

Mac、Raycast、git、Node.js 22.22.2以上が必要です。会話を開くにはSlackのデスクトップアプリも使います。

### 1. Slackのユーザートークンを取得する

1. [Slackのアプリ管理画面](https://api.slack.com/apps)でアプリを作り、使うワークスペースを選びます。
2. **OAuth & Permissions → User Token Scopes**に、以下の8つを追加します。操作の許可を表す設定です。

   ```text
   channels:read
   groups:read
   im:read
   mpim:read
   users:read
   search:read
   chat:write
   im:write
   ```

3. **Install to Workspace**でインストールし、**User OAuth Token**（`xoxp-`）をコピーします。承認制のワークスペースでは管理者の承認が必要です。Bot Token（`xoxb-`）は使えません。

トークンは自分としてSlackを読み書きできる鍵です。共有したりGitHubに貼ったりせず、コピー後はクリップボード履歴からも消してください。

### 2. 拡張をRaycastに取り込む

```bash
git clone https://github.com/shinonomelon/raycast-slack-hub.git ~/raycast-slack-hub
cd ~/raycast-slack-hub
npm ci
npm run dev
```

`built extension successfully`と出たら取り込みは完了です。Control+Cで止めても拡張は残ります。

### 3. Raycastにトークンを設定する

Raycastの設定→ **Extensions → Slack Hub → Slack Access Token**にトークンを入力し、Slack Hubを開き直します。初回は会話・人の一覧を取得するため少し待ちます。

以前の版を使っていた人も入力が必要です。CLIの設定は自動で読みません。ハンドルを変更したことがある人は、任意設定の`Previous Handles`に以前の名前をカンマ区切りで入れてください。

## よく使う操作

Raycastで`Slack Hub`を開き、画面下部のActionsから操作を選びます。キーは画面に表示されたものを使ってください。

| やりたいこと            | 操作                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| チャンネルや人を開く    | 名前を入力 → 行を選ぶ → Open in Slack                                    |
| メッセージを探す        | 語や`in:#チャンネル名`を入力 → 結果を選ぶ → Show Details                 |
| メッセージをSlackで開く | メッセージを選ぶ → Open in Slack                                         |
| 投稿・DMを送る          | 会話や人を選ぶ → Write → 本文を書く → Post and Open in Slack             |
| スレッドに返信する      | メッセージを選ぶ → Reply in Thread → 本文を書く → Post and Open in Slack |
| 自分宛てを確認する      | 検索欄を空にする → 「自分宛て（過去7日）」を見る                         |
| 対応済みにする          | メッセージを選ぶ → Mark as Handled                                       |
| お気に入りにする        | 会話や人を選ぶ → Add to Favorites                                        |
| 一覧を更新する          | Reload Conversations and People。検索や未読情報だけならReload Search     |

検索の条件や詳しい操作は[詳しい使い方](docs/usage.md)を参照してください。

下書き保存には未対応です。`Slack Drafts`では過去の控えだけを閲覧できます。[対応状況はIssue #1](https://github.com/shinonomelon/raycast-slack-hub/issues/1)で確認できます。

## 更新・困ったとき

更新は拡張のフォルダで`git pull` → `npm ci` → `npm run dev`を実行します。

「送れたか未確認です」と出た場合は、Slackで届いたかを確認してから再送してください。届いていると二重投稿になります。

認証エラー、保存データ、削除手順、開発用コマンドは[設定・トラブル対応](docs/reference.md)にまとめています。解決しなければ[GitHub Issues](https://github.com/shinonomelon/raycast-slack-hub/issues)に操作手順とエラーを報告してください。トークンや実際のメッセージ本文は含めないでください。
