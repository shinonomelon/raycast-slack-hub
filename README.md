# Slack Hub

RaycastからSlackのチャンネル・人・グループDMを探し、メッセージの検索・投稿・スレッド返信ができる拡張です。公式Slack Web APIへ直接接続します。slack-cliは不要です。

名前のファジー検索、お気に入り、別名、自分宛ての整理、人の参加チャンネル・共通チャンネル検索に対応しています。Raycast Storeには未公開です。

## インストールする

Mac、Raycast、git、Node.js 22.22.2以上が必要です。会話を開くにはSlackのデスクトップアプリを使います。

### 1. Slackのユーザートークンを取得する

1. [Slackのアプリ管理画面](https://api.slack.com/apps)でアプリを作り、使うワークスペースを選びます。
2. **OAuth & Permissions → User Token Scopes**に、次の8つを追加します。

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

トークンは自分としてSlackを読み書きできる鍵です。GitHubやチャットに貼らず、コピー後はクリップボード履歴からも消してください。

### 2. 拡張をRaycastに取り込む

```bash
git clone https://github.com/shinonomelon/raycast-slack-hub.git ~/raycast-slack-hub
cd ~/raycast-slack-hub
npm ci
npm run dev
```

`built extension successfully`と出たら取り込みは完了です。Control+Cで止めても拡張は残ります。

### 3. Raycastにトークンを設定する

Raycastの設定 → **Extensions → Slack Hub → Slack Access Token**に入力し、Slack Hubを開き直します。初回は会話・人の一覧を取得するため少し待ちます。

ハンドルを変更したことがある人は、任意設定の`Previous Handles`に以前の名前をカンマ区切りで入れてください。旧版のCLI設定は自動で読みません。

## よく使う操作

一覧のReturnはSlackで開く、⌘Returnは詳細を表示・非表示、会話・人の⌘Nは投稿フォームです。Actionsからも選べます。

| やりたいこと             | 操作                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- |
| チャンネルや人を開く     | 名前を入力 → 行を選ぶ → Return                                                    |
| メッセージを読む         | 検索語や`in:#チャンネル名`を入力 → 結果を選ぶ → ⌘Return                           |
| 投稿・DMを送る           | 会話や人を選ぶ → Write → 本文を書く → Post and Open in Slack                      |
| スレッドに返信する       | メッセージを選ぶ → Reply in Thread → 本文を書く → Post and Open in Slack          |
| 自分宛てを整理する       | 検索欄を空にする → 自分宛ての行を選ぶ → Mark as Handled                           |
| 人がいるチャンネルを探す | 人を選ぶ → View Channels with This Person。Add Personで全員の共通チャンネルに絞る |
| チャンネルの参加者を見る | チャンネルを選ぶ → View Members                                                   |

[詳しい使い方](docs/usage.md)に検索条件・全操作・ショートカットをまとめています。

未完了の機能は公開コードから外しました。下書き、履歴・スレッド閲覧、リアクション、ブックマーク、Lists、返信待ち・AI判定は[対応予定](docs/roadmap.md)からIssueを確認できます。

## 更新・困ったとき

更新は拡張のフォルダで`git pull --ff-only` → `npm ci` → `npm run dev`を実行します。

「送れたか未確認です」と出た場合は、Slackで届いたかを確認してから再送してください。届いていると二重投稿になります。

[設定・トラブル対応](docs/reference.md)と[開発手順](docs/development.md)も参照してください。解決しなければ[GitHub Issues](https://github.com/shinonomelon/raycast-slack-hub/issues)へ操作手順とエラーを報告できます。トークンや実際のメッセージ本文は含めないでください。
