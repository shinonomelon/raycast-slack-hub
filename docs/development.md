# Slack Hubを開発する

[READMEへ戻る](../README.md)

## ローカルで動かす

Node.js 22.22.2以上を使います。

```bash
npm ci
npm run dev
```

開発中は変更を監視してRaycastへ反映します。Control+Cで停止しても、取り込んだ拡張は残ります。

## 変更を確認する

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

テストは`src/`配下の`.test.ts`を自動で集めます。多くはSlackに通信せず、応答の例を使って動作を確認します。自動テストの成功と実API・Raycastでの検証は区別してください。lintはRaycastの公開スキーマなどを取得するため、ネット接続が必要になる場合があります。

## コードの配置

| 場所                        | 役割                                       |
| --------------------------- | ------------------------------------------ |
| `src/slack-hub.tsx`         | Slack Hubコマンドの入口                    |
| `src/refresh-directory.ts`  | 一覧をバックグラウンド更新する入口         |
| `src/features/hub/`         | 検索一覧・詳細・操作の組み立て             |
| `src/features/search/`      | 検索条件・回数制限・取得                   |
| `src/features/compose/`     | 投稿・返信フォーム、Markdown変換、送信結果 |
| `src/features/triage/`      | 自分宛て・既読位置・対応済みの印           |
| `src/features/membership/`  | 人の参加チャンネル・共通チャンネル・参加者 |
| `src/features/preferences/` | お気に入り・別名・辞書の編集と保存         |
| `src/slack/`                | Slack API通信・認証・会話と人の取得        |
| `src/shared/`               | 設定・型・名前の照合・共通処理             |
| `docs/`                     | 現在使える機能の手順と対応予定             |

テストは対象ソースの隣に置きます。一時出力はgitignore対象の`.scratch/`へ保存します。

## 未完了機能を再開する

機能名だけの操作や、常に無効な分岐は公開コードに残しません。先に[対応予定](roadmap.md)のIssueで仕様と完了条件を確認してください。削除した実装は各Issueに記載したコミットから参照できます。

新しい権限や依存パッケージは、機能を利用可能にする変更と一緒に追加します。認証情報や実際のSlack本文をテスト・ログ・Issueに含めないでください。
