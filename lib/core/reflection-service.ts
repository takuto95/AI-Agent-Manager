import { callDeepSeek } from "../adapters/deepseek";
import { SYSTEM_PROMPT, buildWeeklyReviewPrompt } from "../prompts";
import { LogsRepository } from "../storage/repositories";

type WeeklyReview = {
  evaluation?: string;
  achievements?: string[];
  goal_adjusted?: string;
  next_week_task?: string;
};

type ReflectionDependencies = {
  logsRepo: LogsRepository;
  aiCaller?: typeof callDeepSeek;
};

function extractLikelyJsonObject(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();

  // Prefer fenced code blocks if present: ```json { ... } ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  return candidate.slice(firstBrace, lastBrace + 1);
}

function parseWeeklyReview(text: string): WeeklyReview | null {
  const json = extractLikelyJsonObject(text);
  if (!json) return null;
  try {
    return JSON.parse(json) as WeeklyReview;
  } catch {
    return null;
  }
}

export class ReflectionService {
  private logsRepo: LogsRepository;
  private aiCaller: typeof callDeepSeek;

  constructor(deps: ReflectionDependencies) {
    this.logsRepo = deps.logsRepo;
    this.aiCaller = deps.aiCaller ?? callDeepSeek;
  }

  async buildWeeklyMessage(daysRange: number, maxRows: number): Promise<string | null> {
    const logs = await this.logsRepo.listRecent(daysRange, maxRows);
    if (!logs.length) {
      return null;
    }

    const weekLogs = logs
      .map(log => `${log.timestamp} | raw:${log.rawText} | summary:${log.todayTask} | emotion:${log.emotion}`)
      .join("\n---\n");

    const output = await this.aiCaller(SYSTEM_PROMPT, buildWeeklyReviewPrompt(weekLogs));

    const parsed = parseWeeklyReview(output);
    if (!parsed) {
      return `週次レビューを解析できなかった。出力:\n${output}`;
    }

    const message = [
      "【週次レビュー】",
      "",
      parsed.evaluation ? parsed.evaluation : null,
      "",
      parsed.achievements?.length
        ? `✨ 今週の成果\n${parsed.achievements.map(a => `・${a}`).join("\n")}`
        : null,
      "",
      parsed.goal_adjusted ? `🎯 次の目標\n${parsed.goal_adjusted}` : null,
      "",
      parsed.next_week_task ? `💪 来週の焦点\n${parsed.next_week_task}` : null
    ]
      .filter(line => line !== null && line !== "")
      .join("\n");

    return message || "レビューを生成できたが内容が空だった。";
  }
}
