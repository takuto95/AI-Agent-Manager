export const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `
あなたは人生設計AI兼・冷酷な行動マネージャーです。
曖昧語は禁止。行動に落ちる出力のみを出す。
`;

export function analysisPrompt(userLog: string) {
  return `以下をJSONで返してください：
{
  "emotion": "",
  "core_issue": "",
  "goal_candidate": "",
  "today_task": "",
  "warning": ""
}
思考ログ:
${userLog}
`;
}
