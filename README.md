# Life AI Agent — 統合版最小実装

LINE Webhook、DeepSeek解析、Google Sheets DB、朝/夜のCron通知、ゴール承認フローを1つのNext.js (App Router) プロジェクトにまとめた完全な最小構成です。Cursor / Vercel にそのまま投入すれば動作します。

## 1. ファイル構成
```
/app/api/webhook/route.ts   # LINE受信 & DeepSeek解析
/app/api/morning/route.ts   # 朝のCron通知 (GET/POSTどちらも可)
/app/api/night/route.ts     # 夜の通知 (必要に応じて手動/外部トリガー)
/app/api/weekly/route.ts    # 週次レビュー通知 (GET/POSTどちらも可)
/app/api/postback/route.ts  # LINEテンプレpostback承認
/lib/deepseek.ts            # DeepSeekラッパー
/lib/sheets.ts              # Google Sheetsユーティリティ
/lib/line.ts                # LINE送信ユーティリティ
/lib/prompts.ts             # 鬼コーチ人格/プロンプト群
/vercel.json                # Vercel Cron設定
.env                        # ローカル環境変数テンプレ
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
1. ユーザーがLINEで送信 → `app/api/webhook/route.ts` が受信。
2. 生ログを `logs` に追記 → DeepSeekへ投入 → `buildAnalysisPrompt` で JSON 解析。
3. 解析結果をLINE返信。`current_goal` があれば「承認:<ゴール名>」返信を促す。
4. ユーザーが `承認:xxx` と送るか、テンプレボタンの postback (`approve_goal:xxx`) を押すと `app/api/postback/route.ts` 経由で `goals` に登録。
5. Cron `/api/morning` が `tasks` から `todo` を拾って命令文を push。
6. `/api/night` は必要に応じて手動 or 外部 scheduler で叩き、進捗確認を push。
7. Cron `/api/weekly` が直近7日のログを DeepSeek でレビューして push。

## 5. vercel.json (Cron)
```json
{
  "crons": [
    { "path": "/api/morning", "schedule": "0 21 * * *" },
    { "path": "/api/weekly", "schedule": "0 12 * * 0" }
  ]
}
```
Vercel無料枠では Cron Job が2件までなので、ここでは「朝」「週次」を常時動かし、夜は手動／外部トリガーで運用する想定です。時刻はUTC基準なので、JST朝6時/週次日曜21時に合わせて 21時/12時(UTC) を指定しています。必要に応じて `schedule` を調整してください。

## 6. セットアップ & デプロイ
1. `npm install`（または `pnpm install`）で依存を導入。
2. `.env` を作成し、上記の環境変数を入力。ローカル検証は `npm run dev`、Vercelローカルは `npm run vercel:dev`。
3. Google Cloud Console でサービスアカウントを作成し、Sheets API を有効化 → メール／秘密鍵を `.env` に設定。
4. Sheets に `goals / tasks / logs / stats` シートを作成し、1行目をヘッダーにする（空行があると `slice(1)` でズレるので注意）。
5. LINE公式アカウントで Messaging API を有効化し、Webhook URL を `https://<vercel-host>/api/webhook` に設定 → 接続確認を ON。
6. リポジトリをGitHubへ push → Vercel プロジェクトを接続し、同じ環境変数を「Environment Variables」に登録 → Deploy。
7. Vercel Dashboard > Cron Jobs で `/api/morning` / `/api/weekly` を確認（`vercel.json` を push 済みなら自動検出）。

## 7. ローカル / 本番テスト手順
1. LINEでBotに「今日は仕事で自信がなかった」などのログを送信。
   - `app/api/webhook/route.ts` が DeepSeek を呼び、`感情/本質/現在ゴール/今日の命令` を返信。
   - `logs` シートに「生ログ」と「解析結果」が2行追記されていることを確認。
2. ゴールを採用したい場合は `承認:○○` と返信 → `goals` シートに `pending` 状態で追加される。テンプレボタンを作っている場合は、押下で `/api/postback` に `approve_goal:○○` が届くか確認。
3. `/api/morning` を叩く（Vercel Cron「Run now」または `curl https://<vercel-host>/api/morning`）と朝の命令文が届く。
4. `/api/night` を手動実行（`curl` か外部 scheduler）し、夜の確認メッセージが届くか確かめる。
5. `/api/weekly` を叩き、直近7日のログが十分なら週次レビューが届く（ログ不足なら警告が返る）。
6. Cron を有効化した後は、Vercel Logs で `morning cron failed` / `weekly endpoint failed` などのエラーがないか監視する。

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
