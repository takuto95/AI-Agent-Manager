# Life AI Agent — 統合版最小実装

LINE Webhook、DeepSeek解析、Google Sheets DB、朝/夜のCron通知、ゴール承認フローを1つのNext.js (App Router) プロジェクトにまとめた完全な最小構成です。Cursor / Vercel にそのまま投入すれば動作します。

## 1. ファイル構成
```
/app/api/line/webhook/route.ts   # LINE受信→GoalIntakeサービス
/app/api/line/postback/route.ts  # ゴール承認postback
/app/api/line/push/route.ts      # 管理者向けpush API
/app/api/jobs/morning/route.ts   # 朝のCron通知 (GET/POST)
/app/api/jobs/night/route.ts     # 夜の確認通知
/app/api/jobs/weekly/route.ts    # 週次レビュー通知
/app/api/goals/route.ts          # Goal API (GET/POST)
/app/api/tasks/route.ts          # Task API (GET/POST)
/app/api/progress/route.ts       # Progress API (GET)
/lib/adapters/*.ts               # DeepSeek / LINE / Sheets アダプタ
/lib/core/*.ts                   # GoalIntake / TaskPlanner / Reflectionサービス
/lib/storage/*.ts                # Repositoryインタフェース & Sheets実装
/lib/prompts.ts                  # 鬼コーチ人格/プロンプト群
/vercel.json                     # Vercel Cron設定
.env                             # ローカル環境変数テンプレ
package.json
next.config.mjs
README.md
```

## 2. 必須環境変数 (.env)
```
DEEPSEEK_API_KEY=xxx
SYSTEM_PROMPT=（未指定なら lib/prompts.ts の鬼コーチ人格を使用）
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
1つのスプレッドシートに **4シート**（`goals / tasks / logs / sessions`）を作成します。

### goals
| A:id | B:title | C:confidence | D:status | E:createdAt | F:updatedAt |

### tasks
| A:id | B:goalId | C:description | D:status | E:dueDate | F:priority | G:assignedAt | H:sourceLogId |

### logs
| A:id | B:timestamp | C:userId | D:rawText | E:emotion | F:coreIssue | G:currentGoal | H:todayTask | I:warning |

### sessions
| A:sessionId | B:userId | C:type | D:content | E:timestamp | F:meta |

## 4. DeepSeek/LINE/Sheets 連携の流れ
1. ユーザーがLINEで送信 → `app/api/line/webhook/route.ts` がセッション（`sessions` シート）を更新しつつ応答。
2. `#整理開始 ... #整理終了` のあと `#タスク整理` を送ると、終了済みログの transcript を DeepSeek に投入して JSON を抽出し、`logs` と `tasks` を追記。
3. ゴール承認は **postbackのみ**対応（`approve_goal:<内容>`）。`app/api/line/postback/route.ts` 経由で `goals` に追加される（現状 status は `pending` 固定）。
4. Cron `/api/jobs/morning` が `tasks` から次の `todo` を拾って命令文を push。
6. `/api/jobs/night` は必要に応じて手動 or 外部 scheduler で叩き、進捗確認を push。
7. Cron `/api/jobs/weekly` が直近7日のログを DeepSeek でレビューして push。

## 5. vercel.json (Cron)
```json
{
  "crons": [
    { "path": "/api/jobs/morning", "schedule": "0 21 * * *" },
    { "path": "/api/jobs/weekly", "schedule": "0 12 * * 0" }
  ]
}
```
Vercel無料枠では Cron Job が2件までなので、ここでは「朝」「週次」を常時動かし、夜は手動／外部トリガーで運用する想定です。時刻はUTC基準なので、JST朝6時/週次日曜21時に合わせて 21時/12時(UTC) を指定しています。必要に応じて `schedule` を調整してください。

## 6. セットアップ & デプロイ
1. `npm install`（または `pnpm install`）で依存を導入。
2. `.env` を作成し、上記の環境変数を入力。ローカル検証は `npm run dev`、Vercelローカルは `npm run vercel:dev`。
3. Google Cloud Console でサービスアカウントを作成し、Sheets API を有効化 → メール／秘密鍵を `.env` に設定。
4. Sheets に `goals / tasks / logs / sessions` シートを作成し、1行目をヘッダーにする（空行があると `slice(1)` でズレるので注意）。
5. LINE公式アカウントで Messaging API を有効化し、Webhook URL を `https://<vercel-host>/api/line/webhook` に設定 → 接続確認を ON。
6. リポジトリをGitHubへ push → Vercel プロジェクトを接続し、同じ環境変数を「Environment Variables」に登録 → Deploy。
7. Vercel Dashboard > Cron Jobs で `/api/jobs/morning` / `/api/jobs/weekly` を確認（`vercel.json` を push 済みなら自動検出）。

## 7. ローカル / 本番テスト手順
1. LINEでBotに「今日は仕事で自信がなかった」などのログを送信。
   - `sessions` シートに user/assistant イベントが追記されていることを確認。
2. `#整理開始` → ログを数回送る → `#整理終了` → `#タスク整理` の順で送る。
   - `logs` に1行、`tasks` に1行以上が追記される（`sourceLogId` で紐付く）。
3. ゴールを採用したい場合は、テンプレボタンなどで postback を送る（`approve_goal:○○`）。`goals` に追加される。
3. `/api/jobs/morning` を叩く（Vercel Cron「Run now」または `curl https://<vercel-host>/api/jobs/morning`）と朝の命令文が届く。
4. `/api/jobs/night` を手動実行（`curl` か外部 scheduler）し、夜の確認メッセージが届くか確かめる。
5. `/api/jobs/weekly` を叩き、直近7日のログが十分なら週次レビューが届く（ログ不足なら警告が返る）。
6. Cron を有効化した後は、Vercel Logs で `morning cron failed` / `weekly endpoint failed` などのエラーがないか監視する。

## 8. コスト抑制の実装ポイント
- DeepSeekへは生ログではなく短い要約プロンプトのみを送信 (コードでJSONテンプレのみ送信)。
- 朝のCronは軽量プロンプトで命令文整形のみ、週次で重い解析をする場合は別関数を作成。
- Sheetsは無料枠で十分。レコード増加時はエクスポートまたは将来Supabaseへ移行。

## 9. 監視・ロギング
- VercelのFunction Logsで `/api/line/webhook` / Cron のエラーを確認。
- DeepSeek/Sheets失敗時はLINEにフォールバック文言を返信する（`app/api/line/webhook/route.ts`）。
- Google Sheetsの行数が増えたら月次でバックアップ (Apps ScriptやCSVエクスポートなど)。

## 10. オプション
- **フルコードパッケージ**: 本リポジトリで提供。
- **プロンプト群**: `lib/prompts.ts` に基本テンプレを格納。必要に応じて朝/夜/週次を追記できます。
- **リッチメニュー/テンプレ**: `lib/adapters/line.ts` のユーティリティを使えばボタン承認に拡張可能です。

このREADMEの手順に沿って環境変数を設定すれば、即座にLINE×DeepSeek×Sheets連携の行動マネージャーを稼働できます。
