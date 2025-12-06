# BMAD AI Agent Service

BMADはSpeckitと同様に、複数のLLMエージェントと企業内ナレッジソースを連携させるAI Agentサービスです。特定分野の業務手順やドキュメントを参照しながら、マルチステップ指示への応答、ワークフロー自動化、ナレッジサマリ生成を提供します。

## サービスコンセプト
- **Knowledge Grounding**: Confluence・Notion・Google DriveなどのリポジトリをBMADインデクサで同期し、RAGを通じて回答の根拠を付与。
- **Multi-Agent Orchestrator**: 課題分解・計画・検証役のエージェントをシナリオに合わせて構成。Speckitで採用しているplaybook概念を継承。
- **Action Connectors**: Slack/Teams、Jira、Salesforce、Webhookなどの業務システムへ書き戻し可能。
- **Observability**: セッションログ、プロンプト/ツール実行トレース、PIIマスキングを標準装備。

## ディレクトリ構成（想定）
- `apps/api` : GraphQL + RESTゲートウェイ (FastAPI)
- `apps/orchestrator` : エージェント実行ランタイム
- `apps/console` : Next.jsベースの管理UI
- `packages/connectors` : 外部SaaSコネクタ群
- `packages/prompt-kits` : ドメイン別テンプレート (Sales, Support, R&D)
- `infra/` : Terraform + GitHub Actionsワークフロー

## 開発環境
- Node.js 20 / pnpm 9
- Python 3.11 (エージェント実行)
- Docker DesktopまたはPodman
- PostgreSQL 15, Redis 7
- OpenAI API / Anthropic API キー

### 初期セットアップ
```bash
git clone <このリポジトリ>
cd ai-agent-manager
pnpm install
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # OpenAI/Anthropic/Slackなどのキーを設定
docker compose up -d postgres redis
pnpm dev:console & pnpm dev:api # UIとAPIを並行起動
```

## 主要機能
- **Workspace管理**: 顧客組織/権限ロールをマルチテナントで管理。
- **Scenario Builder**: Speckitのplaybookと互換なDSLで、エージェントとツールの実行順序を定義。
- **Retriever Sync**: ベクトルDB(Weaviate/pgvector)と埋め込みバッチジョブをスケジュール。
- **Guardrails**: ポリシーチェック、PII検出、セーフプロンプトをチェーン前段に挿入。
- **Analytics**: リクエスト成功率、ツール呼び出し回数、レイテンシをDataDogにストリーミング。

## Speckitとの違い/共通点
- 共通: playbook DSL / multi-agent orchestration / SaaS connectors
- BMAD固有: 研究開発領域向けテンプレート、LLMベンダーミックス、実験ログの自動文書化
- Speckit固有: セールスイネーブルメントに特化したUI、Salesforce CRM連携の深さ

## テスト & 品質管理
- `pnpm lint` / `pnpm test` : UI・API共通のESLint/Jest
- `pytest apps/orchestrator/tests` : エージェントフローの統合テスト
- `docker compose -f docker-compose.e2e.yml up` : コネクタ含むE2E
- mainへのマージはGitHub ActionsでのCI合格が必須

## デプロイ
- mainへpush → Actionsで
  1. Docker build & push
  2. Terraform plan
  3. Argo RolloutsでBlue/Green
- 環境: `dev`, `stg`, `prod`
- 構成: EKS(Fargate) + Aurora PostgreSQL + Elasticache Redis + S3 (ドキュメント格納)

## 運用の要点
- インシデント時は`/incident start BMAD` (Slackコマンド)でテンプレート作成
- プロンプト変更は`prompt-kits/<domain>`ディレクトリでPRレビュー必須
- 新規コネクタは`packages/connectors/<service>`に追加し、APIスキーマを更新

## 参考リンク
- Speckit公式: https://www.spekit.com/
- Multi-agent設計ガイド: https://github.com/microsoft/autogen
- Guardrails例: https://github.com/ShreyaR/guardrails

---
今後、具体的な実装ファイルや環境変数テンプレが追加され次第、このREADMEを基準に詳細を肉付けしてください。