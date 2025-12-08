import { callDeepSeek } from "../adapters/deepseek";
import { SYSTEM_PROMPT, buildWeeklyReviewPrompt } from "../prompts";
import { LogsRepository } from "../storage/repositories";

type WeeklyReview = {
  evaluation?: string;
  excuses_detected?: string[];
  goal_adjusted?: string;
  next_week_task?: string;
};

type ReflectionDependencies = {
  logsRepo: LogsRepository;
  aiCaller?: typeof callDeepSeek;
};

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

    let parsed: WeeklyReview | null = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      return `週次レビューを解析できなかった。出力:\n${output}`;
    }

    if (!parsed) {
      return `週次レビューを解析できなかった。出力:\n${output}`;
    }

    const message = [
      "【週次レビュー】",
      parsed.evaluation ? `評価: ${parsed.evaluation}` : null,
      parsed.excuses_detected?.length
        ? `甘え検出: ${parsed.excuses_detected.join(", ")}`
        : null,
      parsed.goal_adjusted ? `修正ゴール: ${parsed.goal_adjusted}` : null,
      parsed.next_week_task ? `来週の命令: ${parsed.next_week_task}` : null
    ]
      .filter(Boolean)
      .join("\n");

    return message || "レビューを生成できたが内容が空だった。";
  }
}
