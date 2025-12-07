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

export function buildAnalysisPrompt(userLog: string): string {
  return `
ユーザーの思考ログを以下JSONで解析してください。

必ずこの形式の JSON「だけ」を返してください：

{
  "emotion": "",
  "core_issue": "",
  "current_goal": "",
  "today_task": "",
  "warning": ""
}

制約:
- 文章はすべて日本語で書く
- 曖昧な表現は禁止（「そこそこ」「まあまあ」「ぼちぼち」など）
- "today_task" は必ず「具体的行動1つ」にする（例: "○○の本を3ページ読む"）
- "warning" は、怠慢や甘えがある場合にのみ短く厳しめに書く

思考ログ:
${userLog}
`;
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
