import { callDeepSeek } from "../adapters/deepseek";
import { SYSTEM_PROMPT, buildWeeklyReviewPrompt, buildMonthlyReviewPrompt, buildQuarterlyReviewPrompt } from "../prompts";
import { LogsRepository, TasksRepository } from "../storage/repositories";

type WeeklyReview = {
  evaluation?: string;
  achievements?: string[];
  goal_adjusted?: string;
  next_week_task?: string;
};

type ReflectionDependencies = {
  logsRepo: LogsRepository;
  tasksRepo?: TasksRepository;
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
  private tasksRepo?: TasksRepository;
  private aiCaller: typeof callDeepSeek;

  constructor(deps: ReflectionDependencies) {
    this.logsRepo = deps.logsRepo;
    this.tasksRepo = deps.tasksRepo;
    this.aiCaller = deps.aiCaller ?? callDeepSeek;
  }

  async buildWeeklyMessage(daysRange: number, maxRows: number): Promise<string | null> {
    const logs = await this.logsRepo.listRecent(daysRange, maxRows);
    if (!logs.length) {
      return null;
    }

    // 先週の同期間のログを取得
    const lastWeekLogs = await this.logsRepo.listRecent(daysRange * 2, maxRows * 2);
    const now = Date.now();
    const lastWeekStart = now - daysRange * 2 * 24 * 60 * 60 * 1000;
    const lastWeekEnd = now - daysRange * 24 * 60 * 60 * 1000;
    const lastWeekFiltered = lastWeekLogs.filter(log => {
      const logTime = new Date(log.timestamp).getTime();
      return logTime >= lastWeekStart && logTime < lastWeekEnd;
    });

    const thisWeekCount = logs.length;
    const lastWeekCount = lastWeekFiltered.length;
    const difference = thisWeekCount - lastWeekCount;
    const percentChange = lastWeekCount > 0 ? Math.round((difference / lastWeekCount) * 100) : 0;

    let comparisonText = "";
    if (lastWeekCount === 0) {
      comparisonText = "先週の記録なし。今週から始めた！";
    } else if (difference > 0) {
      comparisonText = `📈 先週より${difference}件多い（${percentChange > 0 ? "+" : ""}${percentChange}%）`;
    } else if (difference < 0) {
      comparisonText = `📉 先週より${Math.abs(difference)}件少ない（${percentChange}%）`;
    } else {
      comparisonText = `📊 先週と同じ件数（${thisWeekCount}件）`;
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
      `今週の記録: ${thisWeekCount}件`,
      comparisonText,
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

  async buildMonthlyMessage(daysRange: number, maxRows: number): Promise<string | null> {
    const logs = await this.logsRepo.listRecent(daysRange, maxRows);
    if (!logs.length) {
      return null;
    }

    // タスク完了数を集計
    let taskStats = { done: 0, miss: 0, total: 0 };
    if (this.tasksRepo) {
      const allTasks = await this.tasksRepo.listAll();
      const oneMonthAgo = Date.now() - daysRange * 24 * 60 * 60 * 1000;
      const recentTasks = allTasks.filter(t => new Date(t.assignedAt).getTime() >= oneMonthAgo);
      taskStats.total = recentTasks.length;
      taskStats.done = recentTasks.filter(t => t.status.toLowerCase() === "done").length;
      taskStats.miss = recentTasks.filter(t => t.status.toLowerCase() === "miss").length;
    }

    const monthLogs = logs
      .map(log => `${log.timestamp} | raw:${log.rawText} | summary:${log.todayTask} | emotion:${log.emotion}`)
      .join("\n---\n");

    const prompt = buildMonthlyReviewPrompt(monthLogs, taskStats);
    const output = await this.aiCaller(SYSTEM_PROMPT, prompt);

    const parsed = parseWeeklyReview(output);
    if (!parsed) {
      return `月次レビューを解析できなかった。出力:\n${output}`;
    }

    const message = [
      "【月次レビュー】",
      "",
      `今月の記録: ${logs.length}件`,
      `今月のタスク: ${taskStats.done}件完了 / ${taskStats.total}件（達成率${taskStats.total > 0 ? Math.round((taskStats.done / taskStats.total) * 100) : 0}%）`,
      "",
      parsed.evaluation ? parsed.evaluation : null,
      "",
      parsed.achievements?.length
        ? `✨ 今月の成果\n${parsed.achievements.map(a => `・${a}`).join("\n")}`
        : null,
      "",
      parsed.goal_adjusted ? `🎯 来月の目標\n${parsed.goal_adjusted}` : null,
      "",
      parsed.next_week_task ? `💪 来月の焦点\n${parsed.next_week_task}` : null
    ]
      .filter(line => line !== null && line !== "")
      .join("\n");

    return message || "月次レビューを生成できたが内容が空だった。";
  }

  async buildQuarterlyMessage(daysRange: number, maxRows: number): Promise<string | null> {
    const logs = await this.logsRepo.listRecent(daysRange, maxRows);
    if (!logs.length) {
      return null;
    }

    // タスク完了数を集計
    let taskStats = { done: 0, miss: 0, total: 0 };
    if (this.tasksRepo) {
      const allTasks = await this.tasksRepo.listAll();
      const threeMonthsAgo = Date.now() - daysRange * 24 * 60 * 60 * 1000;
      const recentTasks = allTasks.filter(t => new Date(t.assignedAt).getTime() >= threeMonthsAgo);
      taskStats.total = recentTasks.length;
      taskStats.done = recentTasks.filter(t => t.status.toLowerCase() === "done").length;
      taskStats.miss = recentTasks.filter(t => t.status.toLowerCase() === "miss").length;
    }

    const quarterLogs = logs
      .map(log => `${log.timestamp} | raw:${log.rawText} | summary:${log.todayTask} | emotion:${log.emotion}`)
      .join("\n---\n");

    const prompt = buildQuarterlyReviewPrompt(quarterLogs, taskStats);
    const output = await this.aiCaller(SYSTEM_PROMPT, prompt);

    const parsed = parseWeeklyReview(output);
    if (!parsed) {
      return `四半期レビューを解析できなかった。出力:\n${output}`;
    }

    const quarter = Math.floor(new Date().getMonth() / 3) + 1;
    const message = [
      `【第${quarter}四半期レビュー】`,
      "",
      `今四半期の記録: ${logs.length}件`,
      `今四半期のタスク: ${taskStats.done}件完了 / ${taskStats.total}件（達成率${taskStats.total > 0 ? Math.round((taskStats.done / taskStats.total) * 100) : 0}%）`,
      "",
      parsed.evaluation ? parsed.evaluation : null,
      "",
      parsed.achievements?.length
        ? `✨ 今四半期の成果\n${parsed.achievements.map(a => `・${a}`).join("\n")}`
        : null,
      "",
      parsed.goal_adjusted ? `🎯 来四半期の目標\n${parsed.goal_adjusted}` : null,
      "",
      parsed.next_week_task ? `💪 来四半期の焦点\n${parsed.next_week_task}` : null
    ]
      .filter(line => line !== null && line !== "")
      .join("\n");

    return message || "四半期レビューを生成できたが内容が空だった。";
  }
}
