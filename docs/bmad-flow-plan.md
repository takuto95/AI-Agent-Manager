# BMADフローに基づくBMAD AI Agent Service開発計画

## B (Business/Background)
- **対象顧客**: グローバルに展開するR&D組織およびCS組織。複数のナレッジベース(Confluence/Notion/Drive)を横断的に扱う必要がある。
- **課題**: 属人的なナレッジ参照、複雑なマルチエージェント設計、SaaSコネクタごとの実装コスト。
- **成功指標**: シナリオ構築のリードタイムを50%削減、RAG回答の引用率90%以上、Slack/Jiraコネクタ経由での業務完結率70%。

## M (Market/Modeling)
- **主要ユースケース**
  1. **R&D実験サマリ生成**: 実験ログを取り込み、Guardrailsで機密情報を遮断した上でサマリを生成。
  2. **CSインシデントプレイブック**: Slack `/incident` コマンドから自動でテンプレート展開、Jiraチケットと双方向同期。
  3. **ドキュメントQA**: Scenario Builderで手順を定義し、Retriever Syncから引用付き回答を返却。
- **MVP機能セット**
  - Workspace/Role管理 (Multi-tenant)
  - Scenario Builder DSL v0 (YAMLベース)
  - Retriever Syncジョブ (pgvector)
  - Slackコネクタ (通知/ slash command)
  - FastAPIベースのAPIゲートウェイ(REST + GraphQL)

## A (Architecture/Assemble)
- **システム構成**
  - `apps/api`: FastAPI + Strawberry GraphQL。Workspaces/Scenarios/SyncJobsのAPIとGraphQLエンドポイント。
  - `apps/orchestrator`: エージェント実行ランタイム。Scenario DSLをパースし、LLMとコネクタをオーケストレーション。
  - `apps/console`: Next.js管理UI (今後実装)。
  - `packages/connectors`: Slack/Jira/WebhookなどのAction Connectorをプラガブルに追加。
  - `packages/prompt-kits`: ドメイン別テンプレート群。YAMLで管理。
- **データフロー**
  1. ConsoleからScenario DSLを登録。
  2. APIが設定をPostgreSQL/Redisに格納、pgvectorにドキュメント埋め込み。
  3. Orchestratorがシナリオを実行、Retriever/Guardrails/Connectorsを順次呼び出し。
  4. 実行トレースをObservabilityストリームへ送信(DataDog想定)。
- **技術選定**
  - Python 3.11 + FastAPI: APIとOrchestrator間で型共有。
  - Strawberry GraphQL: Schema-firstでConsoleからの型保証。
  - Pydantic v2: 設定/モデルのバリデーション。
  - AsyncIO + Tenacity: エージェント呼び出しのリトライ制御。

## D (Delivery/Deploy)
- **短期ロードマップ (0-4週間)**
  1. API骨格とGraphQLスキーマ (本PRで開始)。
  2. OrchestratorのScenario Runner + コネクタ抽象化。
  3. Slackコネクタv0とPrompt Kitテンプレート。
  4. Docker Compose (Postgres/Redis) + CIワークフロー雛形。
- **品質/テスト戦略**
  - `pytest apps/orchestrator/tests`: シナリオ実行のユニット+統合テスト。
  - `pnpm lint/test`: Console/Shared UI (後続)。
  - Contract Test: GraphQL schema snapshot + connectorモックテスト。
- **デリバリー**
  - mainブランチはCI必須、タグ付けでArgo Rolloutsへ。
  - Observability/PIIマスキングは必須要件としてIssue化済み(今後実装予定)。
