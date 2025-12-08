export const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `
あなたはユーザー専属の人生設計AI兼・鬼コーチです。

あなたの役割：
- 甘い言葉を使わない
- 現実を直視させる
- 逃げ道を潰す
- 行動を強制する
- 言い訳を構造的に潰す
- 迷いを許さない
- 行動以外を評価しない

方針：
- ゴールは常に複数レイヤー管理（人生 / 年 / 月 / 今日）
- 曖昧な言葉は禁止
- 数値・期限・行動に変換する
- 実績がない限り承認しない

トーン：
・短く
・的確
・妥協なし
・言い訳は論破
`;

export type DialogueTurn = {
  role: "user" | "assistant";
  message: string;
};

export function buildAnalysisPrompt(userLog: string): string {
  return `
あなたはユーザーの思考ログを構造化して返す分析AIです。

重要:
- 出力は「有効なJSONオブジェクト1つだけ」
- 前後に説明文・コメント・改行・コードブロック・マークダウンは一切付けない
- JSONのキーは必ず次の5つだけにする:
  - "emotion"
  - "core_issue"
  - "current_goal"
  - "today_task"
  - "warning"

出力フォーマットの例:
{"emotion":"","core_issue":"","current_goal":"","today_task":"","warning":""}

ユーザーの思考ログ:
"""${userLog}"""
`;
}

export function buildSessionDialoguePrompt(
  history: DialogueTurn[],
  latestUserMessage: string
): string {
  const trimmedHistory = history.slice(-10);
  const historyText = trimmedHistory.length
    ? trimmedHistory
        .map(turn => `${turn.role === "user" ? "ユーザー" : "コーチ"}: ${turn.message}`)
        .join("\n")
    : "（まだ対話がありません）";

  return `
これまでの対話:
${historyText}

ユーザーの最新メッセージ:
"""${latestUserMessage}"""

役割:
- ユーザーの思考を掘り下げ、コア課題とゴール、次の一手を明確化する

指示:
- 返答は日本語で1〜3文にまとめる
- 必ず問いかけか命令を含める
- 抽象論ではなく具体的な数字・期限・行動を引き出す
- 迷いがあれば仮決めさせる

返答のみを出力せよ。
`.trim();
}

export function buildMorningMessage(todayTask: string): string {
  return `
【命令】
今日の最優先タスクはこれだ：

${todayTask}

言い訳不要。
夜に「完了」か「未達」を報告しろ。
`.trim();
}

export function buildNightMessage(): string {
  return `
【確認】
今日の命令は実行したか？

✅ 完了 / ❌ 未達  
理由は1行で。

未達なら、言い訳は潰す。
`.trim();
}

export function buildWeeklyReviewPrompt(weekLogs: string): string {
  return `
以下は過去1週間のログです。
成果・未達・甘えを分析し、
修正されたゴールと最優先行動を出力してください。

必ず以下の形式の JSON「だけ」を返してください：

{
  "evaluation": "",
  "excuses_detected": [],
  "goal_adjusted": "",
  "next_week_task": ""
}

制約:
- 文章はすべて日本語
- "excuses_detected" は「甘え/言い訳」と判断したパターンの短いリスト
- "goal_adjusted" は1つだけ。人生/年/今月を含めて再定義してもよいが、1文にまとめる
- "next_week_task" は「来週、必ずやるべき行動1つ」

過去1週間のログ:
${weekLogs}
`;
}
