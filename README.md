# Slack Hub

Raycast から Slack のチャンネル・人・グループ DM を1つの一覧で探して開き、メッセージの検索、投稿、スレッドへの返信までできる拡張です。Slack との通信は、改造版の slack-cli（Slack をコマンドから呼ぶツール）が、自分で作る Slack アプリのトークンで行います。

初めて入れる人は、「必要なもの」と「入れ方」を上から順に進めてください。入れたあとは、「使い方とキー」以降を、必要なときに開いてください。

## 公開版の制約

公開済みの改造版CLIには `draft` コマンドがありません。このリポジトリのSave as DraftとSlack Draftsには実装がありますが、案内する公開CLIではSlackへの下書き保存は使えません。投稿・返信・検索は使えます。下書き対応は [Issue #1](https://github.com/shinonomelon/raycast-slack-hub/issues/1) で追跡します。

## 共有して使う場合

このリポジトリにはアプリのソースと架空のテストデータだけを含めます。作者のSlackトークン、個人設定、会話一覧、メッセージ、利用履歴は含めません。ユーザーIDとワークスペースは、自分で登録したトークンの `whoami` から取得し、保存データもアカウントごとに分けます。

各利用者が自分のMacにCLIと拡張を入れ、自分のSlackアプリとUser OAuth Tokenを設定します。作者のMacやアカウントへの接続は不要です。Mac・Raycast・改造版CLIへの依存は残ります。Raycast Storeへの配布は行っていません。

説明中の `~/slack-cli` と `~/raycast-slack-hub` は配置例です。別の場所でも動きます。Raycastの設定には、自分が置いたCLIのパスと、自分のNode.jsのパスを入れてください。

## 必要なもの

- Mac と Raycast。Raycast は最新版にして、アカウントにログインしておきます
- Slack のデスクトップアプリ。一覧の「Open in Slack」は、このアプリを開きます
- 使うワークスペースの Slack アカウント。Slack アプリ（手順 2）を作ってインストールできる必要があります。ワークスペースがアプリの承認制のときは、管理者の承認が要ります
- Node.js 22.22.2 以上（npm も一緒に入ります）。Raycast の拡張の部品（`@raycast/api`）が求める版です。`node --version` で確かめ、入っていない・古いときは https://nodejs.org/ から LTS 版を入れます
- git

## 入れ方

入れるものは3つです。Slack を呼ぶコマンド（改造版の slack-cli）、Slack を呼ぶための鍵（自分の Slack アプリのトークン）、Raycast の拡張です。コマンドは、ターミナル（Terminal.app など）に貼り付けて実行します。

### 1. 改造版 slack-cli の入れ方（clone して build する）

Slack Hub は、本家の slack-cli（urugus/slack-cli）に無い機能（`channels --member-only`・`search --format raw`・`channel last-read`・`whoami` など）を使います。そのため、機能を足した改造版を `~/slack-cli` に取ってきて（clone）、動く形に作ります（build）。

```bash
git clone -b slack-hub https://github.com/shinonomelon/slack-cli.git ~/slack-cli
cd ~/slack-cli
git checkout c4919be224d9943a37c35ea4275d1b44b53997ae
npm ci
npm run build
```

公開CLIの検証対象は `c4919be224d9943a37c35ea4275d1b44b53997ae` です。上のcheckoutで同じ版に固定し、作者のローカルにある変更へ依存しません。下書き機能はこの版に含まれません。

`npm ci` は、ロックファイルのとおりの版で部品を入れます。`npm run build` は、動かすファイル `dist/index.js` を作ります。`npm ci` だけでは `dist/` ができないので、必ず実行します（改造版の `.npmrc` が `ignore-scripts=true` で、入れたときの自動のビルドを止めているためです）。

改造版が動くかを確かめます。出力の1行目が `Usage: slack-cli whoami [options]` なら成功です。

```bash
node ~/slack-cli/dist/index.js whoami --help
```

1行目が `Usage: slack-cli [options] [command]`（コマンド全体の使い方）のときは、`whoami` の無い版です。`slack-hub` ブランチではない（本家の `main` など）か、build が古い可能性があります。`git -C ~/slack-cli rev-parse HEAD` が上の検証対象と一致するかを確かめ、`npm run build` をやり直します。

このあとの slack-cli のコマンドは、すべて `node ~/slack-cli/dist/index.js …` の形で書きます。改造版は PATH に入れないので、`slack-cli` とだけ打っても、改造版は動きません。`npm install -g`（Mac 全体に入れるコマンド）も使いません。本家と同じ名前（`@urugus/slack-cli`）なので、すでに入っている本家の slack-cli を置き換えてしまい、本家を使っている他のツールにも影響します。

### 2. Slack アプリの作り方（User OAuth Token を取る）

Slack Hub は、あなたの Slack アカウントとして Slack を呼びます。その鍵（ユーザートークン）を、自分で作る Slack アプリから発行します。アプリは自分専用で、ほかの人は使いません。

1. https://api.slack.com/apps を開きます。使うワークスペースの Slack にログインしておきます。
2. **Create an app** を押し、**Blank app** を選んで **Continue** を押します。アプリ名（例：`Slack Hub`）と使うワークスペースを選んで、**Create** を押します。古い画面では、**Create New App**・**From scratch**・**Create App** の順に押します。
3. 左のメニューの **OAuth & Permissions** を開き、**Scopes** の **User Token Scopes** で **Add an OAuth Scope** を押して、次の8つを足します（**Bot Token Scopes** には足しません）。
   `channels:read`・`groups:read`・`im:read`・`mpim:read`・`users:read`・`search:read`・`chat:write`・`im:write`
4. 同じページの上のほうの **OAuth Tokens** で **Install to Workspace** を押し、許可します。ワークスペースが承認制のときは、インストールが管理者への承認の依頼になります。承認されてから次に進みます。
5. **OAuth Tokens** に出る **User OAuth Token**（`xoxp-` で始まります）をコピーします。**Bot User OAuth Token**（`xoxb-`）が出ていても使いません。ボットのトークンでは、検索も `whoami` も失敗します。

このトークンは、あなたとして Slack を読み書きできる鍵です。人に渡さず、チャット・メール・GitHub に貼らないでください。

公開版は下書き保存に未対応です。AgentsのSlack MCP設定は、[Issue #1](https://github.com/shinonomelon/raycast-slack-hub/issues/1)で対応版の導入手順を公開するまで不要です。

#### User Token Scopes の表

スコープは、Slack Hub が呼ぶ Slack の API ごとに決まります。8つとも要ります。

| Slack Hub でできること                                   | slack-cli のコマンド                   | Slack API                                       | スコープ                                                                   |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| 開くたびに、自分のユーザー ID とワークスペースを確かめる | `whoami`                               | `auth.test`                                     | 不要                                                                       |
| チャンネル（公開）の一覧                                 | `channels --type public`               | `conversations.list`                            | `channels:read`                                                            |
| チャンネル（非公開）の一覧                               | `channels --type private`              | `conversations.list`                            | `groups:read`                                                              |
| グループ DM の一覧                                       | `channels --type mpim`                 | `conversations.list`                            | `mpim:read`                                                                |
| 参加中の公開チャンネルの絞り込み                         | `channels --type public --member-only` | `users.conversations`                           | `channels:read`                                                            |
| 人の一覧                                                 | `users list`                           | `users.list`                                    | `users:read`                                                               |
| メッセージの検索、自分宛て                               | `search --format raw`                  | `search.messages`                               | `search:read`                                                              |
| 未読の数、既読の判定                                     | `channel last-read`                    | `conversations.info`                            | `channels:read`・`groups:read`・`im:read`・`mpim:read`（会話の種類による） |
| 会話への投稿、スレッドへの返信                           | `send -c <会話の ID>`                  | `chat.postMessage`                              | `chat:write`                                                               |
| 人への DM                                                | `send --user-id <ユーザー ID>`         | `conversations.open`、続けて `chat.postMessage` | `im:write`・`chat:write`                                                   |
| 下書きの保存（フォームの ⌘S）                            | `draft`                                | Slack MCP の `slack_send_message_draft`         | 公開版CLIは未対応。Issue #1で追跡                                          |

メールアドレスは使わないので、`users:read.email` は要りません。あとからスコープを足したときは、**Install App** のページの **Reinstall to Workspace** で入れ直します。

### 3. トークンの登録（slack-cli に入れる）

slack-cli は、トークンを「プロファイル」という名前の入れ物に保存します。Slack Hub 用に、`slack-hub` という名前を使います。以降のコマンドの `--profile slack-hub` と、手順 5 の設定 `slack-cli Profile` は、同じ名前にそろえます。

すでに本家の slack-cli を使っている人は、先に次を実行して、いまあるプロファイルの名前を確かめます。本家と改造版は、同じ保存先（`~/.slack-cli/config.json`）を使います。`*` が付いているのが、いまのプロファイルです。

```bash
node ~/slack-cli/dist/index.js config profiles
```

`--profile slack-hub` を付けて登録すると、いまのプロファイルは切り替わらないので、本家を使う他のツールには影響しません。slack-cli を初めて使う人は、登録した `slack-hub` が、いまのプロファイルになります。次の3つは、すでにあるトークンを上書きしたり、いまのプロファイルを切り替えたりするので避けます。

- `--profile` を付けない `config set`。いまのプロファイルのトークンを上書きします
- `default` という名前。いまのプロファイルが `default` に切り替わり、同じ名前があればトークンが上書きされます
- すでにある名前（`config profiles` の一覧にあるもの）。そのトークンが上書きされます。一覧に `slack-hub` があるときは、別の名前（例：`slack-hub-2`）にして、以降の `--profile` と手順 5 の設定も同じ名前にします

登録には、次の2つのどちらかを使います。どちらも、トークンをコマンドの行に書かないので、シェルの履歴に残りません。

トークンを貼り付けて登録する方法です。`Slack API token:` と出たら、コピーしたトークンを貼り付けて ↵ を押します。貼り付けても何も表示されませんが、入っています。

```bash
node ~/slack-cli/dist/index.js config set --profile slack-hub
```

`--token-stdin` を使う方法です。クリップボードにあるトークンを `pbpaste` で取り出し、標準入力で渡します。環境変数 `SLACK_CLI_TOKEN` を設定している人は、上の方法だと入力を求められず、その値が登録されてしまうので、こちらを使います。

```bash
pbpaste | node ~/slack-cli/dist/index.js config set --token-stdin --profile slack-hub
```

`--token <トークン>` の形は使いません。シェルの履歴とプロセスの一覧にトークンが残ります。

`Token saved successfully for profile "slack-hub"` と出たら、登録できています。コピーしたトークンは、Raycast のクリップボード履歴（Clipboard History）にも残るので、その項目を Delete Entry で消します。

登録を確かめます。ユーザー名とワークスペース名が、使いたい自分のものなら成功です。トークンは表示されません。

```bash
node ~/slack-cli/dist/index.js whoami --profile slack-hub
```

`The token is not a user token` と出たときは、ボットのトークン（`xoxb-`）を登録しています。手順 2 の 5 に戻り、`xoxp-` のトークンを登録し直します。

トークンは、`~/.slack-cli/config.json` に暗号化して保存され、鍵は `~/.slack-cli-secrets/master.key` に置かれます。Slack Hub（拡張）自身は、トークンを持ちません。

### 4. 拡張の入れ方（Raycast に取り込む）

公開リポジトリをHTTPSでcloneします。GitHubのアカウント・招待・SSH鍵は不要です。

```bash
git clone https://github.com/shinonomelon/raycast-slack-hub.git ~/raycast-slack-hub
```

clone できたら、次を実行します。

```bash
cd ~/raycast-slack-hub
npm ci
npm run dev
```

`npm run dev` は、拡張を作って Raycast に取り込む、開発用のコマンドです。ターミナルに `built extension successfully` と出たら、取り込みは終わっています。`⌃C`（Control キーを押しながら C）で止めても、拡張は Raycast に残ります。

Raycast を開いて `Slack Hub` で探します。設定を入れる前は、画面の中央に、理由（`slack-cli が見つかりません` など）が出ます。↵ を押すと、設定が開きます。次の手順で設定します。

`npm run build` は使いません。公開用のビルドを作るコマンドで、入れ方には要りません。

### 5. 設定（Raycast に4つ入れる）

Raycast を開いて `⌘,` で設定を開き、Extensions で Slack Hub を選びます。設定は4つで、どれも空欄のまま保存できます。ただし `slack-cli Path` は必ず入れます。空だと、全体に入っている slack-cli を探し、見つかるのはたいてい本家なので、`whoami` が無くて動きません。

| 設定                | 入れる値                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack-cli Path`    | `~/slack-cli/dist/index.js`                                                                                                                                                                                                                                                                                |
| `Node Path`         | Homebrew か Volta で入れた node なら、空でかまいません（`~/.volta/bin`・`/opt/homebrew/bin`・`/usr/local/bin` の順に探します）。nvm・mise・fnm などで入れた人は、ターミナルで `node -p process.execPath` を実行し、出たパスを入れます。`which node` は、fnm では一時的なパスを返すことがあるため使いません |
| `slack-cli Profile` | `slack-hub`（手順 3 で付けた名前）。空だと `--profile` を付けず、slack-cli のいまのプロファイルを使います。本家の slack-cli を使っている人は、必ず入れます                                                                                                                                                 |
| `Previous Handles`  | Slack のハンドルを変えたことがある人だけ。前のハンドルをカンマ区切りで入れます。古いグループ DM の名前には、作ったときのハンドルが残っていて、Slack Hub が名前から自分を除くために使います                                                                                                                 |

設定を入れたら、Slack Hub を開き直します。初回は、会話と人の一覧を Slack から取るので、一覧が出そろうまで待ちます。人の多いワークスペースほど長くかかります。名前を打って、チャンネルや人が並べば、入れ方は終わりです。

## 使い方とキー

Raycast で `Slack Hub` を開きます。

- 名前を打つと、会話（チャンネル・非公開チャンネル・グループ DM）と人が並びます。お気に入りと、未読のある会話が上に来ます。未読の数は、行の右側に赤いタグで出ます。`3+` の `+` は、実際はそれ以上あるという印です。
- 名前と `in:`・`from:`・`to:` の候補は、ファジー検索に対応します。`dca` で `doc_automate`、`doc_autmate` や `doc_auotmate` でも `doc_automate` を探せます。別名と辞書の検索語にも効きます。既存の完全一致・前方一致・部分一致を上位に保ち、その後に英数字の誤字、飛び飛び一致を並べます。
- 飛び飛び入力は3文字以上で、文字の順序を守り、一致区間が入力長の2倍以下の場合に当たります。誤字補正は4文字以上の英数字語に限り、語全体または名前の区切りごとの語に、1文字の挿入・削除・置換か隣接2文字の入れ替えを許容します。日本語の誤字・読み仮名変換は扱いません。スペース区切りの複数語はすべて一致する候補だけを出します。
- 絞り込みのファジー候補は、選んでReturnを押すと正式な語になります。入力ミスのある宛先を自動で確定しません。メッセージ本文の検索は、従来どおりSlackの検索を使います。
- 語や `in:`・`from:`・`to:` を打つと、会話の下に、メッセージの検索結果が新しい順に並びます。1回に100件までなので、古いものは語や日付で絞ります。
- 何も打たずに開くと、先頭に「自分宛て（過去7日）」が出ます。対象は、自分へのメンションと、自分宛ての DM・グループ DM です（自分の投稿は除きます）。そのうち未読のものを並べます。スレッドの返信と、既読かどうか分からないものも、見落とさないように並べます。`@here`・`@channel`・ユーザーグループ宛ては含みません。

検索欄では、次の書き方が使えます。

| 書き方                                                        | 意味                                         |
| ------------------------------------------------------------- | -------------------------------------------- |
| `in:#チャンネル名`                                            | そのチャンネル。`in:@名前` は、その人との DM |
| `from:@ハンドル`                                              | その人の投稿                                 |
| `to:@ハンドル`                                                | その人宛て                                   |
| `from:me`・`to:me`                                            | 自分の投稿、自分宛て                         |
| `-from:@ハンドル`                                             | 頭に `-` を付けると、除外                    |
| `after:`・`before:`・`on:`・`during:`・`has:`・`is:`・`with:` | Slack の検索の書き方のまま渡します           |

`in:` などを打っている間は、候補が先頭に出ます。↵ で確定します。

行の種類ごとの主なキーは、次のとおりです。⌘K を押すと、その行で使える操作と、実際のキーが出ます。

会話・人の行

| キー             | できること                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------- |
| ↵                | Slack で開く                                                                                 |
| ⌘↵               | 投稿のフォームを開く（人の行は DM）                                                          |
| Tab（予備は ⌘F） | その会話・人で絞り込む（検索欄に `in:`・`from:` を足す）                                     |
| ⌘.               | お気に入りに入れる・外す                                                                     |
| ⌘E               | 別名を付ける（別の呼び名でも探せるようにする）                                               |
| ⌘D               | 名前の置き換え辞書を編集する（チャンネル名の語を、自分の呼び方に置き換えて探せるようにする） |
| ⌘⇧C              | ID をコピーする                                                                              |

メッセージの行（検索結果と自分宛て）

| キー             | できること                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------- |
| ↵                | 本文の全文を、一覧の右のサイドバーに出す・閉じる。読むだけなので、「開いた」の印は付きません |
| ⌘↵               | その位置を Slack で開く。スレッドの返信は、スレッドの中が開きます                            |
| ⌘⇧↵              | そのスレッドに返信する。効かないときは、⌘K から Reply in Thread を選びます                   |
| ⌘⇧D              | 「対応済み」の印を付ける・外す                                                               |
| Tab（予備は ⌘F） | その会話で絞り込む                                                                           |
| ⌘Y               | サイドバーを出す・閉じる                                                                     |
| ⌘O               | permalink（メッセージのリンク）をブラウザで開く                                              |
| ⌘⇧C              | permalink をコピーする                                                                       |

「開いた」「対応済み」の印が付いた行は、Slack Hub を開き直すと、自分宛ての一覧から外れます。印は14日で消えます。返信を送れたときも、その行に「開いた」の印が付きます。

どの行でも

| キー      | できること                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Shift+Tab | 会話とメッセージ（検索欄が空のときは自分宛て）の並びを入れ替える                                                                           |
| ⌘R        | 検索、自分宛て、既読位置、お気に入りの未読を取り直す                                                                                       |
| ⌘⇧R       | 会話と人の一覧をすべて取り直す。新しいチャンネルがすぐ欲しいときに使います（自動では、会話の一覧は1時間、人の一覧は1日たつと取り直します） |
| ⌘P        | 検索欄の右のドロップダウンで、すべて・参加中・未参加を切り替える                                                                           |

投稿のフォーム

| キー | できること                                |
| ---- | ----------------------------------------- |
| ⌘↵   | 投稿して、Slack で開く                    |
| ⌘S   | 下書き保存。公開版CLIは未対応（Issue #1） |
| ⌘⇧P  | プレビューを見る                          |

本文は Markdown で書けます。メンションは、本文とは別の欄で選びます。投稿は、あなた自身の投稿として Slack に出ます（ボットの投稿ではありません）。

### 下書きの控え（Slack Drafts）

以下は下書き機能の実装上の動きです。公開版CLIでは下書きを作れないため、新規の控えも作られません。対応状況はIssue #1で確認してください。

フォームの ⌘S で保存した下書きは、Slack の Drafts & sent に入り、Slack のアプリで直して送れます。Raycast の `Slack Drafts` には、保存したときの控え（宛先・本文・時刻）が新しい順に並びます。

| キー | できること                                                             |
| ---- | ---------------------------------------------------------------------- |
| ↵    | 本文の全文を、右のサイドバーに出す・閉じる                             |
| ⌘↵   | Slack で開く。スレッドへの返信の下書きは、スレッドの親の投稿が開きます |
| ⌘⌫   | 控えを消す                                                             |

下書きには、次の制約があります。

- Slack 側の下書きは、Hub から読むことも、消すことも、直すこともできません（Slack に、そのための手段がありません）。直す・送る・消すは、⌘↵ で Slack を開いて行います
- 控えは Slack 側と同期しません。Slack で送った・消した下書きの控えも、⌘⌫ で消すか、保存してから30日たつまで残ります。控えを消しても、Slack 側の下書きは消えません
- 会話の本体（スレッドへの返信でないもの）の下書きは、会話ごとに1件までです。その会話に書きかけがあると、黙って置き換わるか、保存に失敗します。置き換わったときは、前の書きかけが消えます。スレッドへの返信の下書きは、いくつでも並べられます

## 保存するデータ

Slack Hub が手元に残すものは、次のとおりです。トークンを持つのは slack-cli だけで、拡張は持ちません。拡張は自分では通信せず、Slack への通信はすべて slack-cli が行います。

| 場所                                                                                                                                                                | 入るもの                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raycast の Cache（`~/Library/Application Support/com.raycast.macos/extensions/slack-hub/com.raycast.api.cache/`）のうち、ワークスペースと自分の ID ごとに分けるもの | 会話の一覧（名前と ID）、人の一覧（ID・ハンドル・表示名・本名・肩書き）、参加中の公開チャンネルの ID、会話ごとの既読位置（1日）、会話の行を開いた時刻（1日）、「開いた」「対応済み」の印（14日）、自分宛て（過去7日）の前回の結果、お気に入りの未読を数えた結果 |
| 同じ Cache のうち、設定ごとに分けるもの                                                                                                                             | 前回の `whoami` の結果（自分のユーザー ID・ハンドル・ワークスペースの ID など）。`slack-cli Path` と `slack-cli Profile` の組ごとに持ちます                                                                                                                     |
| 同じ Cache のうち、分けないもの                                                                                                                                     | 検索を止めている期限、よく開く順の記録                                                                                                                                                                                                                          |
| 拡張のフォルダの `prefs.json`（`~/Library/Application Support/com.raycast.macos/extensions/slack-hub/prefs.json`）                                                  | お気に入り、別名、名前の置き換え辞書、「参加中」の絞り込みの選択                                                                                                                                                                                                |
| 拡張のフォルダの `send-…` フォルダ                                                                                                                                  | 投稿の本文。送っている間だけ置かれ、終わると消えます                                                                                                                                                                                                            |
| 拡張のフォルダの `drafts.json`                                                                                                                                      | 下書きの控え（下書きの ID・宛先・本文・保存した時刻）。暗号化しません。保存してから30日たつと消えます                                                                                                                                                           |
| 拡張のフォルダの `drafts.json.broken-…`                                                                                                                             | `drafts.json` が壊れていた・読めない控えがあったときに写した元の中身（本文を含みます）。自動では消えないので、要らなければ削除します                                                                                                                            |
| 拡張のフォルダの `draft-…` フォルダ                                                                                                                                 | 下書きの本文。保存している間だけ置かれ、終わると消えます                                                                                                                                                                                                        |
| `~/.slack-cli/config.json`                                                                                                                                          | トークン（暗号化）。プロファイルごとに入ります                                                                                                                                                                                                                  |
| `~/.slack-cli-secrets/master.key`                                                                                                                                   | トークンを暗号化する鍵                                                                                                                                                                                                                                          |
| `~/.slack-cli/update-notifier.json`                                                                                                                                 | slack-cli の更新の確認の記録（本家の最新の版の番号と、確認した日時）                                                                                                                                                                                            |
| Raycast の設定                                                                                                                                                      | 手順 5 の4つの設定。パスと名前だけで、トークンは入りません                                                                                                                                                                                                      |

Cache は、暗号化されない JSON ファイルです。自分宛ての前回の結果には、メッセージの本文が先頭の300字まで入ります。お気に入りの未読の結果は、本文を持ちません。

トークンの暗号化の鍵は、同じユーザーのフォルダにあります。同じ Mac で自分として動くプログラムは、トークンを読み出せます。

`prefs.json` が無い初回だけ、旧版の拡張（`slack-open-channel`・`slack-mention`）の保存ファイルが Raycast の拡張のフォルダにあれば、読んで設定を引き継ぎます。読むだけで、無ければ何もしません。

### 外すとき

1. 拡張：Raycast の設定（`⌘,`）の Extensions で、Slack Hub をアンインストールします。`~/raycast-slack-hub` は削除してかまいません。`~/Library/Application Support/com.raycast.macos/extensions/slack-hub/` が残っていれば、フォルダごと削除すると、`prefs.json`・`drafts.json` と Cache も消えます。
2. slack-cli のトークン：次を実行します。`--profile` を付けないと、いまのプロファイル（本家の slack-cli で使っているものかもしれません）が消えるので、必ず付けます。`~/slack-cli` を削除するのは、このコマンドを実行したあとです（コマンドが `~/slack-cli` の中にあるためです）。`~/.slack-cli-secrets/master.key` は、ほかのプロファイルのトークンも暗号化しているので、消しません。

   ```bash
   node ~/slack-cli/dist/index.js config clear --profile slack-hub
   ```

3. Slack アプリのトークン：https://api.slack.com/apps で作ったアプリを開き、**Revoke all tokens** を押すと、トークンが無効になります。アプリが不要なら、同じ設定ページから削除できます。

## 更新

CLIは検証したコミットへ固定します。対応版が変わったときは、このREADMEのコミットIDに合わせてcheckoutしてください。Slack Hubは `git pull` で新しい版を取り、入れたときと同じ手順をやり直します。

```bash
cd ~/slack-cli
git fetch origin
git checkout c4919be224d9943a37c35ea4275d1b44b53997ae
npm ci
npm run build
```

```bash
cd ~/raycast-slack-hub
git pull
npm ci
npm run dev
```

拡張のほうは、`built extension successfully` と出たら、`⌃C` で止めます。Raycast の設定とトークンは、更新しても残ります。slack-cli だけが更新されたときは、上のブロックだけで足ります。

## 困ったとき

最初の4つは、自分の情報（`whoami` の結果）が取れないときに出る理由です。前回の `whoami` の結果が無いとき（初めて開いたときや、設定を入れる前）は、画面の中央に出ます。前回の結果があるときは、一覧の先頭の行に出ます。どちらも ↵ を押すと、Slack Hub の設定（Open Extension Preferences）が開きます。一覧の行のときは、その行を選んでから押します。

### 「slack-cli が見つかりません」と出る

`slack-cli Path` が空か、指したファイルがありません。`~/slack-cli/dist/index.js` を入れます。入れても出るときは、`ls ~/slack-cli/dist/index.js` でファイルがあるかを確かめます。無ければ、手順 1 の `npm run build` が済んでいません。

### 「node が見つかりません」と出る

`slack-cli Path` が `.js` のファイルなので、動かす node が要ります。nvm・mise・fnm などで入れた node は、`Node Path` が探す3か所にありません。ターミナルで `node -p process.execPath` を実行し、出たパスを `Node Path` に入れます。Node を入れ替えて動かなくなったときも、同じ手順で入れ直します。

### 「この slack-cli には whoami がありません」と出る

`slack-cli Path` が、本家の slack-cli を指しています（本家で `whoami` を呼ぶと `error: unknown command 'whoami'` になります）。`slack-cli Path` を `~/slack-cli/dist/index.js` に直します。直しても出るときは、手順 1 の確かめ（`whoami --help`）をやり直します。

### 「Slack に自分の情報を問い合わせられませんでした」と出る

この理由には、slack-cli のエラーの文が添えられます。同じ確かめは、ターミナルでもできます（手順 3 の最後のコマンド）。文ごとの直し方は、次のとおりです。

- `No configuration found for profile "…"`：`slack-cli Profile` の名前が、手順 3 で登録した名前と違うか、まだ登録していません。`node ~/slack-cli/dist/index.js config profiles` で名前を確かめます。この文は `config set --token <token>` の形を勧めますが、その形は使いません。手順 3 の方法で登録します
- `invalid_auth`・`not_authed`・`token_revoked`・`account_inactive`：トークンが無効です。手順 2 で User OAuth Token を取り直し、手順 3 の同じ名前で登録し直します（上書きされます）
- `The token is not a user token`：ボットのトークン（`xoxb-`）を登録しています。`xoxp-` のトークンを登録し直します
- そのほか：文をそのまま、Slack Hub を渡してくれた人に伝えます。トークンは書きません

### `missing_scope` と出る

会話の一覧の更新や検索の失敗に、`missing_scope` と出ることがあります。足りないスコープがあります。文の `needed:` のあとに、そのスコープの名前が出ます。手順 2 の8つが **User Token Scopes** に入っているかを確かめ、足りないものを足して、**Install App** のページの **Reinstall to Workspace** で入れ直します。入れ直したあとに User OAuth Token が変わっていたら、手順 3 で登録し直します。

### `Update available: … Run: npm install -g @urugus/slack-cli` と出る

ターミナルで slack-cli を使うと、本家に新しい版が出たときに、この案内が出ます。従わないでください。改造版を `npm install -g` で入れていると、本家に戻ってしまい、`whoami` が無くなります。`~/slack-cli` は、この案内では変わりません。出さないようにするには、次を実行して、ターミナルを開き直します（zsh の場合です）。Slack Hub から呼ぶときは、この案内は出ません。

```bash
echo 'export SLACK_CLI_DISABLE_UPDATE_NOTIFIER=1' >> ~/.zshrc
```

### git の依存（`npm install github:…`）として入れたら、`dist/` が無い

自分の `~/.npmrc` に `ignore-scripts=true` があると、git の依存として入れたときのビルド（`prepare`）が走らず、`dist/` ができません。この設定が効くのは git の依存として入れるときだけで、手順 1 の clone には関係しません。手順 1 の方法で入れ直してください。

### 「Slack の回数制限に当たりました」「検索が時間切れでした」と出る

行に出た時刻まで、検索を止めます。その時刻のあとに ⌘R を押すか、検索欄に打ち直すと、検索を再開します。

### 「送れたか未確認です」と出る

投稿は、Slack に届いている可能性があります。トーストの操作（Open Conversation か Open Parent Message）で Slack を開き、届いたかを確かめます。届いていたら、送り直さないでください。同じ投稿が二重になります。

### 「下書きを保存できませんでした」と出る

トーストの文で、理由を見分けます。

- `Slack did not return a draft_id`：その会話に、書きかけの下書きがすでにある可能性があります。Slack でその会話を開き、書きかけを送るか消してから、保存し直します
- `not enabled for Slack MCP`：手順 2 の、Agents の **Slack Model Context Protocol (MCP) Server** のトグルが Off です
- `draft コマンドがありません`：案内する公開版CLIにはdraftがありません。公開版の制約です。Issue #1で対応状況を確認してください

### 「下書きを保存できたか未確認です」と出る

下書きは、作られている可能性があります。トーストの操作で Slack を開くか、Slack の Drafts & sent で確かめてから、保存し直すかを決めます。作られていた場合に保存し直すと、同じ下書きが2つ並ぶことがあるので、フォームで ⌘S を押し直すと確認が出ます。このときは、Slack Drafts に控えは残りません。

### ここに無いとき

[GitHub Issues](https://github.com/shinonomelon/raycast-slack-hub/issues)に、画面に出た文と、どの手順で出たかを報告してください。トークン・実際のメッセージ本文・非公開の会話名は含めないでください。

## 開発時の検証

`npm ci` の後に `npm test`・`npx tsc --noEmit`・`npx eslint src` を実行します。GitHub ActionsはUTC・Asia/Tokyo・America/New_Yorkでテストします。Markdownの期待値はリポジトリ内に含め、作者のスクリプトを参照しません。Voltaのshim経由のプロセス終了テスト4件だけは、Voltaがない環境ではskipします。通常のNode.js経由は全環境で検証します。
