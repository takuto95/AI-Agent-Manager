# 現行仕様（BMAD Method: B/M/A/D）

このドキュメントは **現状のコード/設定から確定できる“事実ベース”の仕様**です（理想案・将来案は含めない）。

## B (Business / Background)
- **体験ゴール**: LINE上で「思考ログ→整理（AI）→タスク化→日報→週次レビュー」まで完結させる。
- **主な価値**: アプリを開かずに通知/チャットのみで行動を前に進める。

## M (Market / Modeling)
### 想定ユーザー
- LINEで日々の状況/感情/進捗を送る個人ユーザー（現状は `LINE_USER_ID` を単一ユーザーとして扱う運用が前提）。

### ドメイン（データモデル）
- **Goal**: `id,title,confidence,status,createdAt,updatedAt`
  - status: `pending | approved | archived`（ただし現行API/実装では主に `pending` を作る）
- **Task**: `id,goalId,description,status,dueDate,priority,assignedAt,sourceLogId`
  - status: `todo/done/miss` を主に使用（文字列で自由だが日報処理がこれを前提）
  - priority: `A/B/C` を想定
- **Log**: `id,timestamp,userId,rawText,emotion,coreIssue,currentGoal,todayTask,warning`
- **SessionEvent (sessionsシート)**: `sessionId,userId,type,content,timestamp,meta`
  - mode: `log | daily`（startイベントのmetaで保持）

### 永続化（Google Sheets スキーマ）
- **goals**: `id,title,confidence,status,createdAt,updatedAt`
- **tasks**: `id,goalId,description,status,dueDate,priority,assignedAt,sourceLogId`
- **logs**: `id,timestamp,userId,rawText,emotion,coreIssue,currentGoal,todayTask,warning`
- **sessions**: `sessionId,userId,type,content,timestamp,meta`

### 主要フロー（LINE）
#### 1) 思考ログ（logモード）
- 開始: `SESSION_START_KEYWORD`（デフォルト `#整理開始`）
  - 互換コマンド: `#ログ開始` でも開始できる（レガシーalias）
- 会話: ユーザーが送るたびに DeepSeek で思考整理（JSON抽出）し返信
- 終了: `SESSION_END_KEYWORD`（デフォルト `#整理終了`）
  - 互換コマンド: `#ログ終了` でも終了できる（レガシーalias）
- その後: `TASK_SUMMARY_COMMAND`（デフォルト `#タスク整理`）で、終了済みログを基にタスク生成

#### 2) タスク整理（ログ→タスク生成）
- 入力: セッションのユーザー発話ログ（複数行の transcript）
- 出力: logs に1件追加 + tasks に複数件追加（AI JSONの `tasks` を採用）

#### 3) 日報（dailyモード）
- 開始: `DAILY_START_KEYWORD`（デフォルト `#日報開始`）
  - todoタスク一覧を返す（ID付き）
  - `#日報開始 1,3` のように後ろに番号/IDを並べると、日報対象タスクを絞り込んで開始できる
- 更新（同モード中のメッセージ）:
  - `done <taskId>` / `miss <taskId> <理由?>` / `note <内容>`
  - task status 更新（done/miss）
    - **更新成否を検証し、失敗時は詳細なエラーメッセージを返す**
    - 更新後の状態を確認して整合性を保証
  - sessions に daily_update を記録
  - `list` / `一覧` で todo 一覧を再表示できる
  - `対象 1,3`（または `report 1,3`）で「日報対象タスク」をメッセージ指定できる（解除は `対象 全部`）
  - `done 1` / `miss 2 理由` のように **番号**でも完了/未達を登録できる（番号は todo全件リスト基準で、対象で絞っても番号は変えない）
  - 上記コマンドに一致しない入力はメモ（note相当）として記録される
  - `status <taskId>`（または `ステータス <taskId>` / `確認 <taskId>`）でタスクの現在の状態を確認できる
- 終了: `DAILY_END_KEYWORD`（デフォルト `#日報終了`）
  - daily_update を集計してサマリー化
  - サマリーを logs に追記（rawTextにサマリー文字列）
  - サマリーと未着手todo一覧を元に DeepSeek で「評価/明日の焦点/タスク見直し案/後続タスク」を生成し返信
  - 後続タスク（0〜5件）が提案された場合は tasks に todo として追加する（sourceLogId は日報logId）
  - タスク見直し案（再スケジュール案）を sessions に保存する
  - 再スケジュール案はこの時点では適用しない（提案表示のみ）
  - ユーザーが `DAILY_RESCHEDULE_COMMAND`（デフォルト `#再スケジュール作成`）を送ると、直近の日報提案から **再スケジュール用の新規タスク（todo）** を作成する
    - `#再スケジュール作成 <dailyLogId>` で対象日報を指定できる

### Cron/ジョブ
- `/api/jobs/morning` (GET/POST): 次の todo 1件を「今日の命令」としてPush
  - 次のtodoの並び順: priority（A→B→C→不明）→ dueDate（早い順/空は後ろ）→ assignedAt（早い順/空は後ろ）→ シート行順
  - Push本文は「やること / 最低ライン / 夜の報告フォーマット」を含む
  - 当日の命令タスクIDを `sessions` に `morning_order` として記録する（todoが無い場合は空で記録し、前日の命令が誤って参照されないようにする）
- `/api/jobs/night` (GET/POST): 夜の確認メッセージをPush
  - 返信は `完了` または `未達 <理由1行>` のみを要求する
  - 返信が日報/思考ログのどのモードでもない場合でも、`完了/未達` を受理し、直近の `morning_order` に紐づくタスクを done/miss 更新（IDが取れない場合は記録のみ）
  - **更新成否を検証し、失敗時はユーザーに警告と再試行方法を提示する**
- `/api/jobs/weekly` (GET/POST): 直近7日ログから週次レビュー（DeepSeek JSON）を生成してPush
- Vercel Cron: `vercel.json` で morning/weekly が定期実行（nightは現状スケジュール外）

## A (Architecture / Assemble)
### 実行基盤
- Next.js App Router（`app/api/**/route.ts`）が実運用の中心。
- Python側（`apps/api`, `apps/orchestrator`）は同居しているが、現行のLINE/タスク/ログの主フローはNext.js側。

### 外部連携
- **LINE Messaging API**: `replyMessage` / `pushMessage`
- **DeepSeek**: `https://api.deepseek.com/v1/chat/completions`（modelは `DEEPSEEK_MODEL` or `deepseek-chat`）
- **Google Sheets**: 永続化（goals/tasks/logs/sessions シート）

### API（Next.js）
- `POST /api/line/webhook`: LINE受信（text messageのみ）→ セッション制御/DeepSeek応答/タスク生成/日報更新
  - `x-line-signature` を検証し、不正な場合は 401 を返す
- `POST /api/line/postback`: postback受信（`approve_goal:<内容>` のみ対応）→ goalsに追加
  - `x-line-signature` を検証し、不正な場合は 401 を返す
- `POST /api/line/push`: 管理用 push（userId省略時は `LINE_USER_ID`）
  - `INTERNAL_API_KEY` による内部認証が必要（Authorization Bearer / `x-internal-api-key` / `?key=`）
- `GET /api/test-deepseek`: DeepSeek疎通確認用（デバッグ用途）
- `GET|POST /api/jobs/morning`: 朝の命令Push
- `GET|POST /api/jobs/night`: 夜の確認Push
- `GET|POST /api/jobs/weekly`: 週次レビューPush
- `GET|POST /api/goals`: goals一覧 / 追加
- `GET|POST /api/tasks`: todo一覧 / 追加
- `GET /api/progress`: 直近ログの取得（3日/最大20行）

## D (Delivery / Deploy)
- **必須環境変数（現行運用に必要）**
  - DeepSeek: `DEEPSEEK_API_KEY`（任意: `DEEPSEEK_MODEL`, `DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_HTTP_LOG*`）
  - LINE: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_USER_ID`
  - Sheets: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEETS_SPREADSHEET_ID`
  - Internal Auth: `INTERNAL_API_KEY`（/api/line/push の実行に必要）
  - Sessionコマンド: `SESSION_START_KEYWORD`, `SESSION_END_KEYWORD`, `TASK_SUMMARY_COMMAND`, `DAILY_START_KEYWORD`, `DAILY_END_KEYWORD`（任意）
- **Vercel Cron**: `vercel.json` で morning/weekly を定期実行
