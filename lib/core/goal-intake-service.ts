import { callDeepSeek } from "../adapters/deepseek";
import { SYSTEM_PROMPT, buildAnalysisPrompt } from "../prompts";
import { LogsRepository, TasksRepository, GoalsRepository } from "../storage/repositories";
import {
  AnalysisResult,
  AnalysisTask,
  GoalIntakePayload,
  GoalIntakeResult
} from "./types";

type Dependencies = {
  logsRepo: LogsRepository;
  tasksRepo: TasksRepository;
  goalsRepo: GoalsRepository;
  aiCaller?: typeof callDeepSeek;
};

function buildLogId() {
  return `l_${Date.now()}`;
}

let taskIdCounter = 0;

function buildTaskId() {
  taskIdCounter += 1;
  return `t_${Date.now()}_${taskIdCounter}`;
}

type RawAnalysisTask = {
  description?: string;
  priority?: string;
  due_date?: string;
  dueDate?: string;
  reason?: string;
};

type RawAnalysis = {
  emotion?: string;
  core_issue?: string;
  coreIssue?: string;
  current_goal?: string;
  currentGoal?: string;
  today_task?: string;
  todayTask?: string;
  warning?: string;
  tasks?: RawAnalysisTask[];
};

function sanitizeString(value?: string) {
  return (value ?? "").trim();
}

function sanitizePriority(value?: string) {
  const normalized = sanitizeString(value).toUpperCase();
  return ["A", "B", "C"].includes(normalized) ? normalized : "";
}

function normalizeTasks(rawTasks?: RawAnalysisTask[]): AnalysisTask[] {
  if (!Array.isArray(rawTasks)) {
    return [];
  }

  return rawTasks
    .map(task => ({
      description: sanitizeString(task.description),
      priority: sanitizePriority(task.priority),
      dueDate: sanitizeString(task.due_date ?? task.dueDate),
      reason: sanitizeString(task.reason)
    }))
    .filter(task => task.description.length > 0)
    .map((task, index) => ({
      description: task.description,
      priority: task.priority || (index === 0 ? "A" : "B"),
      dueDate: task.dueDate,
      reason: task.reason
    }));
}

function buildFallbackTasks(primary: string): AnalysisTask[] {
  if (!primary) return [];
  return [
    {
      description: primary,
      priority: "A",
      dueDate: ""
    }
  ];
}

function parseAnalysis(text: string): AnalysisResult | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as RawAnalysis;
    const tasks = normalizeTasks(raw.tasks);
    const primaryTaskField = sanitizeString(raw.today_task ?? raw.todayTask);
    const todayTask = primaryTaskField || tasks[0]?.description || "";

    return {
      emotion: sanitizeString(raw.emotion),
      coreIssue: sanitizeString(raw.core_issue ?? raw.coreIssue),
      currentGoal: sanitizeString(raw.current_goal ?? raw.currentGoal),
      todayTask,
      warning: sanitizeString(raw.warning),
      tasks: tasks.length ? tasks : buildFallbackTasks(todayTask)
    };
  } catch {
    return null;
  }
}

function buildGoalId() {
  return `g_${Date.now()}`;
}

export class GoalIntakeService {
  private logsRepo: LogsRepository;
  private tasksRepo: TasksRepository;
  private goalsRepo: GoalsRepository;
  private aiCaller: typeof callDeepSeek;

  constructor(deps: Dependencies) {
    this.logsRepo = deps.logsRepo;
    this.tasksRepo = deps.tasksRepo;
    this.goalsRepo = deps.goalsRepo;
    this.aiCaller = deps.aiCaller ?? callDeepSeek;
  }

  /**
   * ゴールを自動的に作成または既存のIDを取得
   * 同じtitleのゴールが既に存在する場合はそのIDを返す
   */
  private async ensureGoal(goalTitle: string): Promise<string> {
    if (!goalTitle || !goalTitle.trim()) {
      return "";
    }

    const normalizedTitle = goalTitle.trim();
    
    // 既存のゴールを確認
    const existingGoals = await this.goalsRepo.list();
    const existing = existingGoals.find(
      g => g.title.toLowerCase() === normalizedTitle.toLowerCase()
    );
    
    if (existing) {
      return existing.id;
    }
    
    // 新規ゴールを作成
    const goalId = buildGoalId();
    const timestamp = new Date().toISOString();
    await this.goalsRepo.add({
      id: goalId,
      title: normalizedTitle,
      confidence: "0.8", // デフォルト値
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    
    return goalId;
  }

  async handle(payload: GoalIntakePayload): Promise<GoalIntakeResult> {
    const timestamp = payload.timestamp ?? new Date().toISOString();
    const logId = buildLogId();
    const prompt = buildAnalysisPrompt(payload.text);
    const aiRaw = await this.aiCaller(SYSTEM_PROMPT, prompt);
    const parsed = parseAnalysis(aiRaw);

    const todayTask = parsed?.todayTask ?? "";

    // ゴールを自動作成または既存IDを取得
    const goalId = parsed?.currentGoal 
      ? await this.ensureGoal(parsed.currentGoal)
      : "";

    await this.logsRepo.add({
      id: logId,
      timestamp,
      userId: payload.userId,
      rawText: payload.text,
      emotion: parsed?.emotion ?? "",
      coreIssue: parsed?.coreIssue ?? "",
      currentGoal: parsed?.currentGoal ?? "",
      todayTask,
      warning: parsed?.warning ?? ""
    });

    if (parsed?.tasks?.length) {
      for (const task of parsed.tasks) {
        const description = task.description?.trim();
        if (!description) {
          continue;
        }

        await this.tasksRepo.add({
          id: buildTaskId(),
          goalId: goalId, // goalsシートのIDを使用
          description,
          status: "todo",
          dueDate: task.dueDate ?? "",
          priority: (task.priority || "B").toUpperCase(),
          assignedAt: timestamp,
          sourceLogId: logId,
          reason: task.reason ?? ""
        });
      }
    }

    return { logId, timestamp, aiRaw, parsed };
  }

  buildReplyMessage(result: GoalIntakeResult): string {
    if (!result.aiRaw || !result.aiRaw.trim()) {
      return [
        "整理しようとしたが、AIの出力が空だった。",
        "もう一度だけ気になることを送ってくれると助かる:",
        "- DeepSeekの生レスポンスの `choices[0].message`（content/thinking/reasoning 系が全部見える形）"
      ].join("\n");
    }
    if (!result.parsed) {
      return [
        "整理しようとしたが、AIの出力がJSONじゃなかった。",
        "そのまま吐く:",
        result.aiRaw
      ].join("\n");
    }

    const { emotion, coreIssue, currentGoal, todayTask, warning, tasks } =
      result.parsed;
    const lines = [
      "整理した。",
      `感情: ${emotion || "未設定"}`,
      `本質: ${coreIssue || "未特定"}`,
      `ゴール: ${currentGoal || "未設定"}`
    ];

    if (tasks?.length) {
      lines.push("", "今日の命令リスト:");
      tasks.forEach((task, index) => {
        const marker = index === 0 ? "★" : "-";
        const priority = task.priority || (index === 0 ? "A" : "B");
        const due = task.dueDate ? ` (期限:${task.dueDate})` : "";
        const reason = task.reason ? `\n  理由: ${task.reason}` : "";
        lines.push(`${marker} [${priority}] ${task.description}${due}${reason}`);
      });
    } else if (todayTask) {
      lines.push("", "今日やるべき一手:", `- ${todayTask}`);
    }

    if (warning) {
      lines.push("", `警告: ${warning}`);
    }

    lines.push("", "やるかやらないかだけ答えろ。");
    return lines.join("\n");
  }
}
