import { NextResponse } from "next/server";
import { TaskPlannerService } from "../../../../lib/core/task-planner-service";
import { TaskPriorityService } from "../../../../lib/core/task-priority-service";
import { BehaviorLearningService } from "../../../../lib/core/behavior-learning-service";
import { buildMorningMessageV2, buildSmartTaskSelectionPrompt } from "../../../../lib/prompts";
import { pushText, pushFlexMessage } from "../../../../lib/adapters/line";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { SessionRepository } from "../../../../lib/storage/session-repository";
import { personalizeMessage } from "../../../../lib/personalization";
import { callDeepSeek } from "../../../../lib/adapters/deepseek";
import { listActiveGoalProgress } from "../../../../lib/storage/repositories";
import { buildMorningTaskFlexMessage } from "../../../../lib/line/flex-messages";

export const runtime = "nodejs";

const storage = createSheetsStorage();
const planner = new TaskPlannerService(storage.tasks);
const sessions = new SessionRepository();
const priorityService = new TaskPriorityService(storage.tasks);
const behaviorService = new BehaviorLearningService(storage.tasks, storage.logs);

async function selectSmartTask(userId: string) {
  const todos = await storage.tasks.listTodos();
  if (todos.length === 0) return null;
  
  // AIによるタスク選定を試みる
  let aiUsed = false;
  try {
    const todosText = todos.map((t, i) => 
      `${i + 1}) [${t.priority || "-"}] ${t.description} (ID:${t.id}, 期限:${t.dueDate || "なし"})`
    ).join("\n");
    
    const recentLogs = await storage.logs.listRecent(3, 10);
    const recentProgress = recentLogs.map(log => 
      `${log.timestamp}: ${log.rawText.substring(0, 100)}`
    ).join("\n");
    
    const goalProgress = await listActiveGoalProgress(storage.goals, storage.tasks);
    const goalProgressText = goalProgress.map(gp => 
      `${gp.goal.title}: ${gp.progressPercent}% (${gp.completedTasks}/${gp.totalTasks})`
    ).join("\n");
    
    const todayDate = new Date().toISOString().split("T")[0];
    
    const prompt = buildSmartTaskSelectionPrompt({
      todos: todosText,
      recentProgress: recentProgress || "（最近の記録なし）",
      goalProgress: goalProgressText || "（ゴール未設定）",
      todayDate
    });
    
    const aiRaw = await callDeepSeek("あなたはタスク選定AIです。", prompt);
    const match = aiRaw?.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const primaryTaskId = parsed.primary?.taskId;
      if (primaryTaskId) {
        const selected = todos.find(t => t.id === primaryTaskId);
        if (selected) {
          aiUsed = true;
          return { task: selected, reason: parsed.primary.reason || "", alternatives: parsed.alternatives || [], aiUsed };
        }
      }
    }
  } catch (error) {
    console.warn("[smart_task_selection] AI selection failed, fallback to default", error);
  }
  
  // AIが失敗した場合は従来通り先頭を返す
  return { task: todos[0], reason: "", alternatives: [], aiUsed };
}

async function sendMorningOrder() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  // 自動優先度調整を実行（期限が近いタスクの優先度を上げる）
  try {
    const adjustmentResult = await priorityService.adjustPriorities();
    if (adjustmentResult.adjusted.length > 0) {
      console.log("[morning] auto-adjusted priorities", {
        count: adjustmentResult.adjusted.length,
        tasks: adjustmentResult.adjusted.map(t => ({ id: t.id, priority: t.priority }))
      });
    }
  } catch (error) {
    console.warn("[morning] priority adjustment failed", error);
    // 優先度調整の失敗はタスク選定を止めない
  }

  // 行動パターンに基づく提案を取得
  const now = new Date();
  const weekday = now.getDay();
  const hour = now.getHours();
  let contextSuggestions: string[] = [];
  
  try {
    const context = await behaviorService.suggestTasksForContext(weekday, hour);
    contextSuggestions = context.suggestions;
  } catch (error) {
    console.warn("[morning] behavior analysis failed", error);
  }

  const smartSelection = await selectSmartTask(userId);
  if (!smartSelection) {
    const message = "todoタスクがない。まず「#整理開始」→「#整理終了」→「#タスク整理」でタスクを作れ。";
    const settings = await storage.userSettings.getOrDefault(userId);
    await pushText(userId, personalizeMessage(message, settings));
    return;
  }
  
  const { task, reason, aiUsed } = smartSelection;
  const todayTask = task.description.trim();

  // Keep a durable pointer so the user can reply "完了/未達" without entering daily mode.
  await sessions.recordMorningOrder(userId, task.id);

  // ゴール情報を取得
  let goalTitle: string | undefined;
  if (task.goalId) {
    try {
      const goal = await storage.goals.getById(task.goalId);
      goalTitle = goal?.title;
    } catch (error) {
      console.warn("[morning] failed to fetch goal", error);
    }
  }

  // Flex Message を使用（リッチな通知）
  const flexMessage = buildMorningTaskFlexMessage({
    task: {
      id: task.id,
      description: task.description,
      priority: task.priority,
      dueDate: task.dueDate,
      goalTitle
    },
    aiReason: aiUsed ? reason : undefined,
    contextSuggestion: contextSuggestions.length > 0 ? contextSuggestions[0] : undefined,
    aiUsed
  });

  // パーソナライズ（altTextに適用）
  const settings = await storage.userSettings.getOrDefault(userId);
  const greetings = [
    "おはよう。今日もやっていこう。",
    "新しい1日だ。今日も前に進もう。",
    "おはよう。今日は何ができる？",
    "いい朝だ。今日も一歩ずつ。",
    "おはよう。できることから始めよう。"
  ];
  const dayIndex = new Date().getDate() % greetings.length;
  const greeting = greetings[dayIndex];
  const personalizedGreeting = personalizeMessage(greeting, settings);
  
  const altText = `${personalizedGreeting}\n🎯 今日の焦点: ${task.description}`;
  
  await pushFlexMessage(userId, altText, flexMessage);
}

async function respond() {
  try {
    await sendMorningOrder();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("morning job failed", error);
    return NextResponse.json(
      { ok: false, error: error?.message || "failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return respond();
}

export async function POST() {
  return respond();
}
