# 不足点・未決定事項（BMAD Methodの観点）

このリストは「仕様として決める必要があること」を集約します。決まったものは `docs/bmad/spec-current.md` に反映してここはクローズします。

## 最優先（混在/事故につながる）
- [ ] **ユーザー識別/マルチユーザー方針**: 現状は `LINE_USER_ID` にPushする運用前提だが、webhookの `source.userId` とどう紐付けるか（複数ユーザー対応する/しない、いつする）
- [ ] **ジョブ/管理APIの認証方針**:
  - 現状: `/api/line/push` は `INTERNAL_API_KEY` で保護されているが、`/api/jobs/*` は Vercel Cron 都合で未保護
  - 決める: cronを壊さずに保護する方法（IP allowlist / Vercel側の保護 / 外部ジョブ実行基盤への移管 など）

## 仕様の穴（状態/遷移/整合性）
- [ ] **Goalのstatus遷移定義**: `pending/approved/archived` をいつ/誰が/どう更新するか（現状は追加のみ）
- [ ] **Taskのstatus語彙の固定**: `todo/done/miss` 以外を許すか、missの再スケジュール概念を持つか
- [ ] **重複生成の扱い**: `#タスク整理` を同じログに対して複数回実行したい/したくない（現状はanalysis済みだと拒否）

## UX/会話仕様
- [ ] **日報での入力例/エラーメッセージ整備**: taskIdの提示/コピペしやすさ、失敗時の再試行導線
- [ ] **postbackの仕様範囲**: `approve_goal:` 以外（延期/完了ボタンなど）を追加するか

## 非機能（運用/信頼性/コスト）
- [ ] **DeepSeek失敗時の期待動作**: リトライ方針、ユーザーへのメッセージ、部分成功（ログ保存だけする等）
- [ ] **Google Sheetsの上限/運用**: 行数増加時のパフォーマンス、バックアップ、スキーマ変更手順
- [ ] **PII/ログ方針**: DeepSeek HTTPログを有効化した際に何を残すか、マスキングの要否
- [ ] **時刻/タイムゾーン**: CronのUTC/JST、logsのtimestampの扱い

## テスト/品質ゲート
- [ ] **受入条件（Given/When/Then）**: 最低限の主要フロー（思考ログ→タスク化→日報→週次）
- [ ] **モック戦略**: LINE/DeepSeek/Sheets の契約テスト or 疑似実装
- [ ] **回帰観点**: キーワード変更やプロンプト変更で壊れやすい箇所の固定（ゴールデンテキスト等）

---

## 受入条件テンプレ（埋めていく）
### 思考ログ（開始→会話→終了）
- Given: ユーザーがLINEでボットに話しかける
- When: `#整理開始`（または `#ログ開始`）を送る
- Then: 「思考ログモード開始」メッセージと終了方法（`#整理終了`）が返る

- Given: 思考ログモード中
- When: 任意の文章を送る
- Then: DeepSeek分析結果が返り、sessionsに user/assistant イベントが追記される

- Given: 思考ログモード中で、ユーザー発話が1件以上ある
- When: `#整理終了`（または `#ログ終了`）を送る
- Then: セッションが終了し、次に `#タスク整理` でタスク化できる案内が返る

### タスク整理（#タスク整理）
- Given: 直近に終了済みの思考ログセッションがある
- When: `#タスク整理` を送る
- Then: logsに1件、tasksに1件以上のtodoが追加され、返信に「このログID」が含まれる

- Given: すでにタスク化済みの思考ログセッションがある
- When: 同じ対象に対して `#タスク整理` を送る
- Then: 仕様で定めたとおり（現状は拒否）に案内される

### 日報（開始→更新→終了）
- Given: 日報モードではない
- When: `#日報開始` を送る
- Then: todo一覧（ID付き）と入力例（done/miss/note/list）が返る

- Given: 日報モード中で todo がある
- When: `done <taskId>` を送る
- Then: tasksのstatusがdoneになり、日報サマリーに✅完了として記録される

- Given: 日報モード中で todo がある
- When: `miss <taskId> <理由?>` を送る
- Then: tasksのstatusがmissになり、日報サマリーに❌未達として記録される

- Given: 日報モード中
- When: `list`（または `一覧`）を送る
- Then: todo一覧（ID付き）が再表示される

- Given: 日報モード中
- When: `#日報終了` を送る
- Then: 日報サマリーが返り、logsにサマリーが追記される（更新があった場合）
- And: 評価/明日の焦点/タスク見直し案/後続タスク提案が返る（DeepSeek失敗時はサマリーのみでもよい）
- And: 後続タスクが提案された場合、tasksにtodoとして追加される
- And: task_review に reschedule/reprioritize が含まれた場合、tasks の dueDate/priority が更新される
- And: reschedule の対象タスクが miss の場合、status が todo に戻る

### ジョブ（morning/weekly）
- Given: `INTERNAL_API_KEY` が設定されている
- When: `/api/jobs/morning` をキー付きで叩く
- Then: LINEに朝メッセージがpushされる
