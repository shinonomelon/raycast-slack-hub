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

| 場所                            | 役割                                           |
| ------------------------------- | ---------------------------------------------- |
| `src/slack-hub.tsx`             | Slack Hubコマンドの入口                        |
| `src/refresh-directory.ts`      | 一覧をバックグラウンド更新する入口             |
| `src/features/hub/`             | 検索一覧・詳細・操作の組み立て                 |
| `src/features/search-scope/`    | 範囲・投稿者の条件、検索計画、条件選択画面     |
| `src/features/channel-library/` | チャンネルお気に入り・セクションの保存と管理   |
| `src/features/search/`          | 検索条件・回数制限・取得                       |
| `src/features/compose/`         | 投稿・返信フォーム、Markdown変換、送信結果     |
| `src/features/triage/`          | 自分宛て・既読位置・対応済みの印               |
| `src/features/reply-priority/`  | 返信待ち取得・5分キャッシュ・Jev判定と画面     |
| `src/features/membership/`      | 人の参加チャンネル・共通チャンネル・参加者     |
| `src/features/preferences/`     | 人物・グループDMのお気に入り、別名・辞書の保存 |
| `src/slack/`                    | Slack API通信・認証・会話と人の取得            |
| `src/shared/`                   | 設定・型・名前の照合・共通処理                 |
| `docs/`                         | 現在使える機能の手順と対応予定                 |

テストは対象ソースの隣に置きます。一時出力はgitignore対象の`.scratch/`へ保存します。

## 未完了機能を再開する

機能名だけの操作や、常に無効な分岐は公開コードに残しません。先に[対応予定](roadmap.md)のIssueで仕様と完了条件を確認してください。削除した実装は各Issueに記載したコミットから参照できます。

新しい権限や依存パッケージは、機能を利用可能にする変更と一緒に追加します。認証情報や実際のSlack本文をテスト・ログ・Issueに含めないでください。

## Jevの品質を検証する

`reply-priority-ai-evaluation.ts`に架空の日本語会話50件と順位比較15組を置いています。推論前に正解を確定します。自動試験のmock結果は集計式の検証であり、実Jevの品質の証拠にはしません。

合格条件は、必要な依頼18/20件、不要な共有16/20件、緊急案件が上位10件に9件以上、順位比較12/15組、曖昧なケース8/10件です。評価結果を見て判定文を変更した場合、同じ例文で合格判定せず、新しい未使用の例文を用意します。結果にはモデル・判定文の版・使用量・所要時間と合否を残し、キーと実Slack本文は保存しません。

実Jev品質、実画面の送信・中断、返信成功・失敗、認証変更の試験は、[対応予定](roadmap.md)で自動検証と区別して追跡しています。
