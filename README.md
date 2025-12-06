# Life AI Agent — 統合版最小実装

LINE Webhook、DeepSeek解析、Google Sheets DB、朝/夜のCron通知、ゴール承認フローを1つのNext.js( pages API )プロジェクトにまとめた完全な最小構成です。Cursor / Vercel にそのまま投入すれば動作します。

## 1. ファイル構成
```
/api/webhook.ts        # LINE受信&DeepSeek解析
/api/postback.ts       # LINE postback承認
/api/morning.ts        # 朝のCron通知
/api/night.ts          # 夜のCron通知
/lib/deepseek.ts       # DeepSeekラッパー
/lib/sheets.ts         # Google Sheetsユーティリティ
/lib/line.ts           # LINE送信ユーティリティ
/lib/prompts.ts        # プロンプトテンプレ
/vercel.json           # Cron設定
.env                   # ローカル環境変数テンプレ
package.json
next.config.mjs
README.md
```

## 2. 必須環境変数 (.env)
```
DEEPSEEK_API_KEY=xxx
SYSTEM_PROMPT=あなたは人生設計AI兼・冷酷な行動マネージャーです...
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_CHANNEL_SECRET=xxx
LINE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxx
GOOGLE_CLIENT_EMAIL=xxx@appspot.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SHEETS_SPREADSHEET_ID=1xxxxxxxxxx
BASE_URL=https://your-vercel-url.vercel.app
```
- `GOOGLE_PRIVATE_KEY` の改行は `\n` で表現してください (Vercelでも同様)。
- `LINE_USER_ID` は Cron の push 送信用に固定IDを入れておきます。

## 3. Google Sheets スキーマ
1つのスプレッドシートに4シートを作成します。

### goals
| A:id | B:goal | C:confidence | D:status | E:created_at | F:updated_at |

### tasks
| A:id | B:goal_id | C:task | D:status | E:due | F:priority | G:assigned_date |

### logs
| A:date | B:raw | C:summary | D:emotion | E:goal_hint | F:attached_task |

### stats
| A:week_start | B:completion_rate | C:note |

## 4. DeepSeek/LINE/Sheets 連携の流れ
1. ユーザーがLINEで送信 → `/api/webhook` が受信。
2. 生ログを `logs` に追記 → DeepSeekへ投入 → 解析JSONをパース。
3. 解析結果をLINE返信。`goal_candidate` があれば「承認:〜」返信を促す。
4. ユーザーが `承認:新しいゴール` と送ると `goals` に登録。
5. Cron `/api/morning` が未完了タスクを命令文に整形して push。
6. Cron `/api/night` が進捗報告を催促。

## 5. vercel.json (Cron)
```json
{
  "crons": [
    { "path": "/api/morning", "schedule": "0 21 * * *" },
    { "path": "/api/night", "schedule": "0 11 * * *" }
  ]
}
```
VercelはUTC動作なので、JSTで朝6時/夜20時に送る場合は上記のように21時/11時を指定します。

## 6. セットアップ&デプロイ手順
1. `npm install` (または `pnpm install`) — 依存: `axios`, `@line/bot-sdk`, `googleapis`, `next`。
2. `.env` を作成して上記環境変数を入力。ローカル検証は `npm run dev`、Vercelローカルは `npm run vercel:dev`。
3. Google Cloud Console でサービスアカウントを発行し、Sheets API を有効化 → メールと秘密鍵を `.env` に設定。
4. Sheets に `goals / tasks / logs / stats` シートを作成し、1行目にヘッダーを入れる。
5. LINE公式アカウントを作成 → Webhook URL を `https://<vercel-host>/api/webhook` に設定し有効化。
6. リポジトリをGitHubへpush → Vercelでプロジェクトを作成し、同じリポジトリを接続。
7. Vercelの「Environment Variables」に `.env` と同じキーを設定 → Deploy。
8. Vercelダッシュボードの「Cron Jobs」で `/api/morning` / `/api/night` を Run Now すれば即時検証可能。

## 7. テスト手順
1. LINEでBotに「今日は仕事で自信がなかった」と送信。
2. DeepSeek解析結果がLINEに表示され、`goal_candidate` があれば承認案内が出る。
3. `承認:はい` または `承認:ゴール内容` を送信すると `goals` シートに行が追加される。
4. VercelのCron "Run Now" で `/api/morning` を実行 → LINEに「今日の最優先」が届く。
5. `/api/night` を実行 → 進捗確認メッセージが届く。
6. Google Sheets の `logs` / `goals` に追記されていることを確認。

## 8. コスト抑制の実装ポイント
- DeepSeekへは生ログではなく短い要約プロンプトのみを送信 (コードでJSONテンプレのみ送信)。
- 朝のCronは軽量プロンプトで命令文整形のみ、週次で重い解析をする場合は別関数を作成。
- Sheetsは無料枠で十分。レコード増加時はエクスポートまたは将来Supabaseへ移行。

## 9. 監視・ロギング
- VercelのFunction Logsで `/api/webhook` / Cron のエラーを確認。
- DeepSeek失敗時はLINEに「解析に失敗しました」と返信するフェイルセーフ済み。
- Google Sheetsの行数が増えたら月次でバックアップ (Apps ScriptやCSVエクスポートなど)。

## 10. オプション
- **フルコードパッケージ**: 本リポジトリで提供。
- **プロンプト群**: `lib/prompts.ts` に基本テンプレを格納。必要に応じて朝/夜/週次を追記できます。
- **リッチメニュー/テンプレ**: `lib/line.ts` の `pushConfirm` を使えばボタン承認に拡張可能です。

このREADMEの手順に沿って環境変数を設定すれば、即座にLINE×DeepSeek×Sheets連携の行動マネージャーを稼働できます。
