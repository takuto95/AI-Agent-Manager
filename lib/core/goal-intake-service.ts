import { callDeepSeek } from "../adapters/deepseek";
import { SYSTEM_PROMPT, buildAnalysisPrompt } from "../prompts";
import { LogsRepository, TasksRepository } from "../storage/repositories";
import { AnalysisResult, GoalIntakePayload, GoalIntakeResult } from "./types";

type Dependencies = {
  logsRepo: LogsRepository;
  tasksRepo: TasksRepository;
  aiCaller?: typeof callDeepSeek;
};

function buildLogId() {
  return `l_${Date.now()}`;
}

function buildTaskId() {
  return `t_${Date.now()}`;
}

function parseAnalysis(text: string): AnalysisResult | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as AnalysisResult;
    return parsed;
  } catch {
    return null;
  }
}

export class GoalIntakeService {
  private logsRepo: LogsRepository;
  private tasksRepo: TasksRepository;
  private aiCaller: typeof callDeepSeek;

  constructor(deps: Dependencies) {
    this.logsRepo = deps.logsRepo;
    this.tasksRepo = deps.tasksRepo;
    this.aiCaller = deps.aiCaller ?? callDeepSeek;
  }

  async handle(payload: GoalIntakePayload): Promise<GoalIntakeResult> {
    const timestamp = payload.timestamp ?? new Date().toISOString();
    const logId = buildLogId();
    const prompt = buildAnalysisPrompt(payload.text);
    const aiRaw = await this.aiCaller(SYSTEM_PROMPT, prompt);
    const parsed = parseAnalysis(aiRaw);

    await this.logsRepo.add({
      id: logId,
      timestamp,
      userId: payload.userId,
      rawText: payload.text,
      emotion: parsed?.emotion ?? "",
      coreIssue: parsed?.coreIssue ?? "",
      currentGoal: parsed?.currentGoal ?? "",
      todayTask: parsed?.todayTask ?? "",
      warning: parsed?.warning ?? ""
    });

    if (parsed?.todayTask) {
      await this.tasksRepo.add({
        id: buildTaskId(),
        goalId: parsed.currentGoal || "",
        description: parsed.todayTask,
        status: "todo",
        dueDate: "",
        priority: "A",
        assignedAt: timestamp,
        sourceLogId: logId
      });
    }

    return { logId, timestamp, aiRaw, parsed };
  }

  buildReplyMessage(result: GoalIntakeResult): string {
    if (!result.parsed) {
      return [
        "整理しようとしたが、AIの出力がJSONじゃなかった。",
        "そのまま吐く:",
        result.aiRaw
      ].join("\n");
    }

    const { emotion, coreIssue, currentGoal, todayTask, warning } = result.parsed;
    const lines = [
      "整理した。",
      `感情: ${emotion || "未設定"}`,
      `本質: ${coreIssue || "未特定"}`,
      `ゴール: ${currentGoal || "未設定"}`
    ];

    if (todayTask) {
      lines.push("", "今日やるべき一手:", `- ${todayTask}`);
    }

    if (warning) {
      lines.push("", `警告: ${warning}`);
    }

    lines.push("", "やるかやらないかだけ答えろ。");
    return lines.join("\n");
  }
}
