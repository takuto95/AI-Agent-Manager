import { NextResponse } from "next/server";
import { GoalIntakeService } from "../../../../lib/core/goal-intake-service";
import { GoalPredictionService } from "../../../../lib/core/goal-prediction-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { TaskRecord, GoalProgress, listActiveGoalProgress, calculateGoalProgress, UserSettingsRecord, CharacterRole, MessageTone } from "../../../../lib/storage/repositories";
import { replyText, replyTexts, replyTextWithQuickReply } from "../../../../lib/adapters/line";
import { callDeepSeek } from "../../../../lib/adapters/deepseek";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_THOUGHT, buildDailyReviewPrompt, buildThoughtAnalysisPrompt } from "../../../../lib/prompts";
import { authorizeLineWebhook } from "../../../../lib/security/line-signature";
import { LearningService } from "../../../../lib/core/learning-service";
import { personalizeMessage } from "../../../../lib/personalization";
import {
  SessionEvent,
  SessionMode,
  SessionRepository,
  SessionTranscript
} from "../../../../lib/storage/session-repository";

export const runtime = "nodejs";

const LOG_START_KEYWORD = process.env.SESSION_START_KEYWORD?.trim() || "#整理開始";
const LOG_END_KEYWORD = process.env.SESSION_END_KEYWORD?.trim() || "#整理終了";
const TASK_SUMMARY_COMMAND = process.env.TASK_SUMMARY_COMMAND?.trim() || "#タスク整理";
const DAILY_START_KEYWORD = process.env.DAILY_START_KEYWORD?.trim() || "#日報開始";
const DAILY_END_KEYWORD = process.env.DAILY_END_KEYWORD?.trim() || "#日報終了";
const DAILY_RESCHEDULE_COMMAND = process.env.DAILY_RESCHEDULE_COMMAND?.trim() || "#再スケジュール作成";
const LEGACY_LOG_START_KEYWORD = "#ログ開始";
const LEGACY_LOG_END_KEYWORD = "#ログ終了";
const HELP_COMMANDS = new Set(["/help", "/?", "#help", "#ヘルプ", "help", "ヘルプ", "?"]);
const STATUS_CHECK_PATTERN = /^(status|ステータス|確認)\s+(.+)$/i;
const SPLIT_TASK_PATTERN = /^(split|分割)\s+(.+)$/i;
const RETRY_TASK_PATTERN = /^(retry|再挑戦|もう一度)\s+(.+)$/i;
const SETTINGS_PATTERN = /^(#設定|設定)\s+(.+)$/i;
const RESET_COMMANDS = new Set(["#リセット", "リセット", "#reset", "reset"]);
const STATUS_COMMANDS = new Set(["#状態", "状態", "#status"]);
const GOAL_COMPLETE_PATTERN = /^(#ゴール完了|ゴール完了|#goal\s*complete)\s+(.+)$/i;
const GOAL_LIST_COMMANDS = new Set(["#ゴール一覧", "ゴール一覧", "#goals", "#goal list"]);
const GOAL_PROGRESS_PATTERN = /^(#ゴール進捗|ゴール進捗|#goal\s*progress)(?:\s+(.+))?$/i;

function buildCommandReply() {
  return `未対応コマンドだ。「${LOG_START_KEYWORD}」/「${LOG_END_KEYWORD}」/「${TASK_SUMMARY_COMMAND}」/「${DAILY_START_KEYWORD}」/「${DAILY_END_KEYWORD}」/「${DAILY_RESCHEDULE_COMMAND}」だけ使え。\n\nタスク確認: status <taskId>`;
}

function buildInactiveMenuMessage() {
  return "何をする？番号で選んで。";
}

function buildInactiveMenuButtons() {
  return [
    { label: "1️⃣ 思考を整理する", text: "1" },
    { label: "2️⃣ 今日の報告をする", text: "2" },
    { label: "3️⃣ タスクを作る", text: "3" },
    { label: "❓ 使い方を見る", text: "?" }
  ] as const;
}

function buildInactiveMenuText() {
  return [
    "何をする？番号で選んで。",
    "",
    "1️⃣ 思考を整理する（モヤモヤを言語化）",
    "2️⃣ 今日の報告をする（done/miss）",
    "3️⃣ タスクを作る（思考→タスク化）",
    "❓ 使い方を見る"
  ].join("\n");
}

type LineMessage = {
  type?: string;
  text?: string;
};

type LineEvent = {
  type?: string;
  replyToken?: string;
  message?: LineMessage;
  source?: { userId?: string };
};

type LineWebhookBody = {
  events?: LineEvent[];
};

const storage = createSheetsStorage();
const goalIntakeService = new GoalIntakeService({
  logsRepo: storage.logs,
  tasksRepo: storage.tasks,
  goalsRepo: storage.goals
});
const sessionRepository = new SessionRepository();
const learningService = new LearningService(storage.tasks);
const predictionService = new GoalPredictionService(storage.goals, storage.tasks);

// パーソナライズ対応のreply関数（すべてのreplyTextをラップ）
async function replyPersonalized(userId: string, replyToken: string, message: string) {
  const settings = await storage.userSettings.getOrDefault(userId);
  const personalized = personalizeMessage(message, settings);
  await replyText(replyToken, personalized);
}

async function replyPersonalizedTexts(userId: string, replyToken: string, messages: string[]) {
  const settings = await storage.userSettings.getOrDefault(userId);
  const personalized = messages.map(msg => personalizeMessage(msg, settings));
  await replyTexts(replyToken, personalized);
}

// 全ハンドラーで使用する統一的なreply（userIdがある場合は自動パーソナライズ）
async function reply(replyToken: string, message: string, userId?: string) {
  if (userId) {
    await replyPersonalized(userId, replyToken, message);
  } else {
    await replyText(replyToken, message);
  }
}

async function replyMultiple(replyToken: string, messages: string[], userId?: string) {
  if (userId) {
    await replyPersonalizedTexts(userId, replyToken, messages);
  } else {
    await replyTexts(replyToken, messages);
  }
}

function isTextMessageEvent(event: LineEvent | undefined): event is LineEvent & {
  message: LineMessage & { type: "text" };
} {
  return !!event && event.type === "message" && event.message?.type === "text";
}

function buildConversationTranscript(events: SessionEvent[]) {
  return events
    .filter(event => event.type === "user")
    .map(event => `${event.timestamp || ""} ユーザー: ${event.content}`)
    .join("\n---\n");
}

function buildUserThoughtLog(events: SessionEvent[]) {
  return events
    .filter(event => event.type === "user")
    .map(event => event.content)
    .join("\n---\n");
}

type ThoughtAnalysis = {
  emotion: string;
  coreIssue: string;
  currentGoal: string;
  aiSummary: string;
  aiSuggestion: string;
  userNextStep: string;
};

type RawThoughtAnalysis = {
  emotion?: string;
  core_issue?: string;
  coreIssue?: string;
  current_goal?: string;
  currentGoal?: string;
  ai_summary?: string;
  aiSummary?: string;
  ai_suggestion?: string;
  aiSuggestion?: string;
  user_next_step?: string;
  userNextStep?: string;
};

function sanitizeField(value?: string) {
  return (value ?? "").trim();
}

function parseThoughtAnalysisResponse(text: string): ThoughtAnalysis | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as RawThoughtAnalysis;
    return {
      emotion: sanitizeField(parsed.emotion),
      coreIssue: sanitizeField(parsed.core_issue ?? parsed.coreIssue),
      currentGoal: sanitizeField(parsed.current_goal ?? parsed.currentGoal),
      aiSummary: sanitizeField(parsed.ai_summary ?? parsed.aiSummary),
      aiSuggestion: sanitizeField(parsed.ai_suggestion ?? parsed.aiSuggestion),
      userNextStep: sanitizeField(parsed.user_next_step ?? parsed.userNextStep)
    };
  } catch {
    return null;
  }
}

function compactReplyLines(lines: string[]) {
  const compact: string[] = [];
  for (const line of lines) {
    if (line === "" && compact[compact.length - 1] === "") {
      continue;
    }
    compact.push(line);
  }
  while (compact[compact.length - 1] === "") {
    compact.pop();
  }
  return compact.join("\n");
}

async function handleTaskRetry(userId: string, replyToken: string, taskIdOrNumber: string) {
  const taskId = taskIdOrNumber.trim();
  if (!taskId) {
    await reply(replyToken, "タスクIDまたは番号を指定しろ。例: retry t_1766122744120_1 または retry 1", userId);
    return NextResponse.json({ ok: true, note: "missing_task_id" });
  }

  // タスク取得（missタスクの中から）
  const allTasks = await storage.tasks.listAll();
  const missTasks = allTasks.filter(t => t.status.toLowerCase() === "miss");
  
  let task = missTasks.find(t => t.id === taskId);
  if (!task) {
    // 番号指定の可能性
    const taskNumber = parseInt(taskId, 10);
    if (!isNaN(taskNumber) && taskNumber > 0 && taskNumber <= missTasks.length) {
      task = missTasks[taskNumber - 1];
    }
  }

  if (!task) {
    await reply(
      replyToken,
      [
        `missタスク「${taskId}」は見つからない。`,
        "",
        "missタスクの一覧を見るには、思考ログで「missタスクを見せて」と言ってくれ。"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, note: "miss_task_not_found" });
  }

  if (task.status.toLowerCase() !== "miss") {
    await reply(
      replyToken,
      [
        `タスク「${taskId}」はmissではない（現在: ${task.status}）。`,
        "再挑戦はmissタスクにのみ使える。"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, note: "not_miss_task" });
  }

  // missタスクをtodoに戻す
  try {
    const updateSuccess = await storage.tasks.updateStatus(task.id, "todo");
    if (!updateSuccess) {
      throw new Error("updateStatus returned false");
    }
    
    // 確認
    const updated = await storage.tasks.findById(task.id);
    if (!updated || updated.status.toLowerCase() !== "todo") {
      throw new Error("Status verification failed");
    }
    
    await reply(
      replyToken,
      [
        "✅ 再挑戦を設定した。",
        "",
        `タスク: ${task.description}`,
        `状態: miss → todo`,
        "",
        "もう一度やってみよう。今度はできる。"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, mode: "task_retry_success", taskId: task.id });
  } catch (error) {
    console.error("retry error", error);
    await reply(
      replyToken,
      [
        "❌ 再挑戦の設定に失敗した。",
        "",
        `タスクID: ${task.id}`,
        "もう一度試してくれ。"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: false, note: "retry_update_failed", error: String(error) });
  }
}

async function handleTaskSplit(userId: string, replyToken: string, taskIdOrNumber: string) {
  const taskId = taskIdOrNumber.trim();
  if (!taskId) {
    await replyText(replyToken, "タスクIDまたは番号を指定しろ。例: split t_1766122744120_1 または split 1");
    return NextResponse.json({ ok: true, note: "missing_task_id" });
  }

  // タスク取得
  let task = await storage.tasks.findById(taskId);
  if (!task) {
    // 番号指定の可能性
    const todos = await storage.tasks.listTodos();
    const taskNumber = parseInt(taskId, 10);
    if (!isNaN(taskNumber) && taskNumber > 0 && taskNumber <= todos.length) {
      task = todos[taskNumber - 1];
    }
  }

  if (!task) {
    await replyText(replyToken, `タスクID「${taskId}」は見つからない。list で一覧を確認しろ。`);
    return NextResponse.json({ ok: true, note: "task_not_found" });
  }

  // AIに分割案を生成
  const splitPrompt = `
以下のタスクを、より細かく実行可能な3〜5個のサブタスクに分割してください。
各サブタスクは30分〜1時間で完了できる粒度にしてください。

元のタスク:
${task.description}

出力は必ず次のJSON形式「だけ」で返してください:
{
  "sub_tasks": [
    {
      "description": "サブタスクの説明（30〜80文字）",
      "priority": "A|B|C",
      "reason": "このサブタスクが必要な理由（1行）"
    }
  ],
  "rationale": "このように分割した理由（2〜3行）"
}
`;

  const aiRaw = await callDeepSeek(SYSTEM_PROMPT, splitPrompt);
  let parsed: { sub_tasks?: Array<{ description: string; priority?: string; reason?: string }>; rationale?: string } | null = null;
  
  try {
    const match = aiRaw?.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    }
  } catch (e) {
    console.error("split parse error", e);
  }

  if (!parsed || !parsed.sub_tasks?.length) {
    await replyText(
      replyToken,
      [
        "タスク分割案の生成に失敗した。",
        "もう一度試すか、思考ログで相談してくれ。"
      ].join("\n")
    );
    return NextResponse.json({ ok: true, note: "split_ai_failed" });
  }

  // 分割案を表示
  const lines = [
    `【タスク分割案】`,
    `元タスク: ${task.description}`,
    "",
    `${parsed.rationale || ""}`,
    "",
    "サブタスク:"
  ];

  parsed.sub_tasks.forEach((subTask, index) => {
    const priority = subTask.priority || "B";
    const reason = subTask.reason ? `\n  → ${subTask.reason}` : "";
    lines.push(`${index + 1}. [${priority}] ${subTask.description}${reason}`);
  });

  lines.push(
    "",
    "この分割案でよければ「承認」と送ってください。",
    "元タスクを「done」にして、サブタスクを追加します。"
  );

  // セッションにメタデータを保存（承認待ち状態）
  const session = await sessionRepository.getActiveSession(userId);
  if (session) {
    session.metadata = session.metadata || {};
    session.metadata.pendingSplit = {
      originalTaskId: task.id,
      subTasks: parsed.sub_tasks.map(st => ({
        description: st.description,
        priority: st.priority || "B",
        reason: st.reason || ""
      }))
    };
  }

  await replyText(replyToken, lines.join("\n"));
  return NextResponse.json({ ok: true, mode: "split_proposal", taskId: task.id });
}

function buildThoughtReplyMessage(parsed: ThoughtAnalysis | null, aiRaw: string): string {
  if (!parsed) {
    return compactReplyLines([
      "ちょっと整理がうまくいかなかった。",
      "もう一度、今の気持ちを送ってくれる？",
      "",
      aiRaw || "(AI出力が空でした)"
    ]);
  }

  const lines: string[] = [];
  
  // 感情を共感的に受け止める
  if (parsed.emotion) {
    lines.push(`${parsed.emotion}`);
    lines.push("");
  }
  
  // 現状の整理（簡潔に）
  if (parsed.aiSummary) {
    lines.push(parsed.aiSummary);
    lines.push("");
  }
  
  // 深掘り質問 or 気づきを促す提案
  if (parsed.aiSuggestion) {
    lines.push(parsed.aiSuggestion);
    lines.push("");
  }
  
  // 核心を突く質問
  const nextStep = parsed.userNextStep || "それで、本当はどう感じてる？";
  lines.push(nextStep);

  return compactReplyLines(lines);
}

function buildThoughtReplyMessages(parsed: ThoughtAnalysis | null, aiRaw: string): string[] {
  if (!parsed) {
    return [compactReplyLines([
      "ちょっと整理がうまくいかなかった。",
      "もう一度、今の気持ちを送ってくれる？",
      "",
      aiRaw || "(AI出力が空でした)"
    ])];
  }

  const messages: string[] = [];
  
  // 1つ目: 感情の共感
  if (parsed.emotion) {
    messages.push(parsed.emotion);
  }
  
  // 2つ目: 現状の整理
  const summaryParts: string[] = [];
  if (parsed.aiSummary) {
    summaryParts.push(parsed.aiSummary);
  }
  if (parsed.aiSuggestion) {
    summaryParts.push("", parsed.aiSuggestion);
  }
  if (summaryParts.length > 0) {
    messages.push(compactReplyLines(summaryParts));
  }
  
  // 3つ目: 核心を突く質問
  const nextStep = parsed.userNextStep || "それで、本当はどう感じてる？";
  messages.push(nextStep);

  return messages.filter(Boolean);
}

type DailyUpdateRecord = {
  taskId: string;
  status: string;
  note?: string;
  timestamp: string;
};

type DailyTaskSelectionPayload = {
  selectedTaskIds: string[];
  raw?: string;
  timestamp: string;
};

type DailyReviewTask = {
  description: string;
  priority: string;
  dueDate: string;
};

type DailyReviewResult = {
  evaluation: string;
  tomorrowFocus: string[];
  taskReview: Array<{
    taskId: string;
    action: string;
    recommendation: string;
    newDueDate: string;
    newPriority: string;
    reason: string;
  }>;
  followUpTasks: DailyReviewTask[];
};

type DailyReviewStoredPayload = {
  dailyLogId: string;
  generatedAt: string;
  review: DailyReviewResult;
};

type DailyReviewApplyPayload = {
  dailyLogId: string;
  appliedAt: string;
  createdTaskIds: string[];
};

function sessionMode(session: SessionTranscript | null): SessionMode {
  if (!session) return "log";
  return SessionRepository.getSessionMode(session);
}

function isLogSession(session: SessionTranscript | null) {
  return sessionMode(session) === "log";
}

function isDailySession(session: SessionTranscript | null) {
  return sessionMode(session) === "daily";
}

async function buildDailyTaskLine(task: TaskRecord, index: number) {
  const priority = (task.priority || "").trim() || "-";
  const description = (task.description || "").trim() || "（説明なし）";
  const metaParts = [`id:${task.id}`];
  if (task.dueDate) metaParts.push(`期限:${task.dueDate}`);
  
  // ゴール情報を追加
  if (task.goalId) {
    const goal = await storage.goals.findById(task.goalId);
    if (goal) {
      metaParts.push(`→ ${goal.title}`);
    }
  }
  
  const meta = metaParts.join(" / ");
  return `${index + 1}) [${priority}] ${description}\n   ${meta}`;
}

async function buildDailyTaskListMessage(tasks: TaskRecord[], title = "未着手タスク一覧", allTodos?: TaskRecord[], limit?: number) {
  if (!tasks.length) {
    return "【未着手タスク】\n（todoは0件）\n今日はメモだけ残してもいい。";
  }
  
  const displayTasks = limit ? tasks.slice(0, limit) : tasks;
  const hasMore = limit && tasks.length > limit;
  const moreCount = hasMore ? tasks.length - limit : 0;
  
  const header = `【${title}】（${tasks.length}件${hasMore ? `・表示${limit}件` : ""}）`;
  const base = allTodos && allTodos.length ? allTodos : tasks;
  const indexById = new Map(base.map((t, idx) => [t.id, idx]));
  const lines = await Promise.all(displayTasks.map((task, index) =>
    buildDailyTaskLine(task, indexById.get(task.id) ?? index)
  ));
  
  if (hasMore) {
    lines.push(`\n他${moreCount}件あり。全件表示: list`);
  }
  
  return [header, ...lines].join("\n");
}

function normalizeQuickReportText(text: string) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parseQuickNightReport(text: string): { status: "done" } | { status: "miss"; reason: string } | null {
  const normalized = normalizeQuickReportText(text);
  if (!normalized) return null;

  if (/^(✅\s*)?完了$/u.test(normalized)) {
    return { status: "done" };
  }

  const miss = normalized.match(/^(❌\s*)?未達(?:\s+(.+))?$/u);
  if (miss) {
    return { status: "miss", reason: (miss[2] || "").trim() };
  }

  return null;
}

function buildQuickNightLogId() {
  return `night_${Date.now()}`;
}

async function tryHandleQuickNightReport(userId: string, replyToken: string, userText: string) {
  const parsed = parseQuickNightReport(userText);
  if (!parsed) return false;

  const taskId = await sessionRepository.findLatestMorningOrderTaskId(userId);
  const task = taskId ? await storage.tasks.findById(taskId) : null;
  const taskDesc = (task?.description || "").trim();
  const timestamp = new Date().toISOString();

  let updateSuccess = false;
  let updateError: string | null = null;

async function handleMorningTaskChange(userId: string, replyToken: string, userText: string) {
  // 候補タスクを3件取得
  const todos = await storage.tasks.listTodos();
  
  if (todos.length === 0) {
    await replyPersonalized(
      userId,
      replyToken,
      "todタスクが見つからない。まず「#整理開始」→「#整理終了」→「#タスク整理」でタスクを作れ。"
    );
    return NextResponse.json({ ok: true, note: "no_todos" });
  }
  
  // 条件指定の判定
  const lowerText = userText.toLowerCase();
  let filtered = todos;
  let conditionNote = "";
  
  if (lowerText.includes("スマホ") || lowerText.includes("携帯")) {
    // スマホで可能なタスク（読む/調べる/考えるなど）
    filtered = todos.filter(t => 
      t.description.includes("読") || 
      t.description.includes("調べ") || 
      t.description.includes("考え") ||
      t.description.includes("要約") ||
      t.description.includes("リサーチ")
    );
    conditionNote = "（スマホで可能なタスクに絞り込み）";
  } else if (lowerText.includes("軽い") || lowerText.includes("短時間")) {
    // 優先度B/Cのタスク（比較的軽め）
    filtered = todos.filter(t => {
      const priority = (t.priority || "").trim().toUpperCase();
      return priority === "B" || priority === "C" || priority === "";
    });
    conditionNote = "（軽めのタスクに絞り込み）";
  } else if (lowerText.includes("休む") || lowerText.includes("スキップ")) {
    // 今日はタスクなし
    await sessions.recordMorningOrder(userId, "");
    await replyPersonalized(
      userId,
      replyToken,
      "了解。今日はタスクなしで記録した。休息も大切だ。"
    );
    return NextResponse.json({ ok: true, mode: "morning_skip" });
  }
  
  if (filtered.length === 0) {
    await replyPersonalized(
      userId,
      replyToken,
      `条件に合うタスクが見つからない${conditionNote}。\n\n「変更」と送れば全タスクから選択できる。`
    );
    return NextResponse.json({ ok: true, note: "no_filtered_todos" });
  }
  
  // 最大3件表示
  const candidates = filtered.slice(0, 3);
  const lines = [`【候補タスク】${conditionNote}`];
  
  candidates.forEach((task, index) => {
    const priority = task.priority || "-";
    const due = task.dueDate ? ` (期限:${task.dueDate})` : "";
    lines.push(`${index + 1}) [${priority}] ${task.description}${due}`);
  });
  
  lines.push(
    "",
    "番号で選んでください（1/2/3）",
    "または「今日は休む」でスキップ"
  );
  
  await replyPersonalized(userId, replyToken, lines.join("\n"));
  
  // 選択待ち状態をセッションに保存
  await sessionRepository.appendUserMessage("morning_task_selection", userId, JSON.stringify({
    candidates: candidates.map(t => t.id),
    timestamp: new Date().toISOString()
  }));
  
  return NextResponse.json({ ok: true, mode: "morning_task_selection" });
}

async function tryHandleMorningTaskSelection(userId: string, replyToken: string, userText: string) {
  // セッションから選択待ち状態を取得
  const sessions = await sessionRepository.listSessions(userId);
  const latest = sessions
    .flatMap(s => s.events)
    .filter(e => e.type === "user" && e.content.includes("candidates"))
    .slice(-1)[0];
  
  if (!latest) return false;
  
  let candidateIds: string[] = [];
  try {
    const parsed = JSON.parse(latest.content);
    candidateIds = parsed.candidates || [];
  } catch {
    return false;
  }
  
  // 番号選択の判定
  const num = parseInt(userText.trim(), 10);
  if (isNaN(num) || num < 1 || num > candidateIds.length) {
    return false;
  }
  
  const selectedTaskId = candidateIds[num - 1];
  const task = await storage.tasks.findById(selectedTaskId);
  
  if (!task) {
    await replyPersonalized(userId, replyToken, "タスクが見つからない。もう一度「変更」と送れ。");
    return NextResponse.json({ ok: true, note: "task_not_found" });
  }
  
  // 選択されたタスクを morning_order に記録
  await sessionRepository.recordMorningOrder(userId, selectedTaskId);
  
  await replyPersonalized(
    userId,
    replyToken,
    [
      `了解。今日の焦点を変更した。`,
      "",
      `🎯 ${task.description}`,
      "",
      "報告: 完了 / 未達 理由"
    ].join("\n")
  );
  
  return NextResponse.json({ ok: true, mode: "morning_task_changed" });
}

  if (taskId) {
    try {
      updateSuccess = await storage.tasks.updateStatus(taskId, parsed.status);
      if (!updateSuccess) {
        updateError = "タスクが見つからないか、すでに更新されている";
        console.warn("[night_report] updateStatus returned false", { taskId, status: parsed.status });
      } else {
        // 更新後の状態を確認
        const updated = await storage.tasks.findById(taskId);
        if (updated && updated.status !== parsed.status) {
          updateError = `検証失敗（期待: ${parsed.status} / 実際: ${updated.status}）`;
          console.error("[night_report] status verification failed", {
            taskId,
            expectedStatus: parsed.status,
            actualStatus: updated.status
          });
        } else {
          console.log("[night_report] success", { taskId, status: parsed.status });
        }
      }
    } catch (error) {
      updateError = (error as Error)?.message || "不明なエラー";
      console.error("[night_report] updateStatus failed", { taskId, error: (error as Error)?.message });
    }
  }

  const lines: string[] = ["【夜報告】", parsed.status === "done" ? "✅完了" : "❌未達"];
  lines.push(`対象:${taskId || "-"}`);
  if (taskDesc) {
    lines.push(`内容:${taskDesc}`);
  }
  if (parsed.status === "miss") {
    lines.push(`理由:${parsed.reason || "-"}`);
  }
  if (updateError) {
    lines.push(`⚠️更新エラー:${updateError}`);
  }

  await storage.logs.add({
    id: buildQuickNightLogId(),
    timestamp,
    userId,
    rawText: lines.join("\n"),
    emotion: "",
    coreIssue: "",
    currentGoal: "",
    todayTask: "",
    warning: updateError || ""
  });

  const replyLines: string[] = [];
  if (taskId) {
    if (updateSuccess && !updateError) {
      replyLines.push(parsed.status === "done" ? "受理: ✅完了。反映した。" : "受理: ❌未達。反映した。");
    } else {
      replyLines.push(
        parsed.status === "done"
          ? "⚠️完了報告を受理したが、タスク更新に失敗した。"
          : "⚠️未達報告を受理したが、タスク更新に失敗した。"
      );
      replyLines.push(`理由: ${updateError}`);
      replyLines.push(`再試行するなら「#日報開始」→「done ${taskId}」または「miss ${taskId} 理由」を送れ。`);
    }
  } else {
    replyLines.push("受理: 記録は残した。だが本日の命令タスクIDが特定できない。");
    replyLines.push("明日はタスクを作れ（#整理開始 → #整理終了 → #タスク整理）。");
  }
  if (parsed.status === "miss" && parsed.reason) {
    replyLines.push("次の一手を1つだけ送れ（具体行動）。");
  }
  await replyText(replyToken, replyLines.join("\n"));

  return true;
}

function parseDailyUpdatePayload(payload: string): DailyUpdateRecord | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as DailyUpdateRecord;
  } catch {
    return null;
  }
}

function collectDailyUpdates(session: SessionTranscript): DailyUpdateRecord[] {
  return session.events
    .filter(event => event.type === "daily_update")
    .map(event => parseDailyUpdatePayload(event.content))
    .filter((record): record is DailyUpdateRecord => !!record);
}

function buildDailySummary(updates: DailyUpdateRecord[]) {
  if (!updates.length) {
    return "報告記録は空だった。";
  }
  const lines = updates.map(update => {
    const note = update.note ? ` | ${update.note}` : "";
    const label = update.status === "done" ? "✅完了" : update.status === "miss" ? "❌未達" : "📝メモ";
    const identifier = update.taskId === "メモ" ? "" : ` ${update.taskId}`;
    return `${label}${identifier}${note}`;
  });
  return ["【日報サマリー】", ...lines].join("\n");
}

function buildDailyLogId() {
  return `daily_${Date.now()}`;
}

let followUpTaskIdCounter = 0;

function buildFollowUpTaskId() {
  followUpTaskIdCounter += 1;
  return `t_${Date.now()}_${followUpTaskIdCounter}`;
}

function sanitizeString(value?: string) {
  return (value ?? "").trim();
}

function parseDailyTaskSelectionPayload(payload: string): DailyTaskSelectionPayload | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<DailyTaskSelectionPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    const selectedTaskIds = Array.isArray(parsed.selectedTaskIds)
      ? parsed.selectedTaskIds.map(id => sanitizeString(String(id))).filter(Boolean)
      : [];
    const timestamp = sanitizeString(parsed.timestamp);
    return { selectedTaskIds, raw: sanitizeString(parsed.raw), timestamp: timestamp || new Date().toISOString() };
  } catch {
    return null;
  }
}

function getLatestDailySelectedTaskIds(session: SessionTranscript): string[] {
  const latest = [...session.events].reverse().find(event => event.type === "daily_task_selection");
  if (!latest) return [];
  const parsed = parseDailyTaskSelectionPayload(latest.content);
  return parsed?.selectedTaskIds ?? [];
}

function normalizeSelectionTokens(raw: string): string[] {
  const s = (raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\s,、]+/g)
    .map(t => t.trim())
    .filter(Boolean);
}

async function resolveDisplayedTodoList(session: SessionTranscript): Promise<{
  todos: TaskRecord[];
  displayed: TaskRecord[];
  selectedIds: string[];
}> {
  const todos = await storage.tasks.listTodos();
  const selectedIds = getLatestDailySelectedTaskIds(session);
  const selectedSet = new Set(selectedIds);
  const displayed = selectedIds.length ? todos.filter(t => selectedSet.has(t.id)) : todos;
  return { todos, displayed, selectedIds };
}

async function applyDailyTaskSelectionFromText(session: SessionTranscript, userId: string, rawText: string) {
  const tokens = normalizeSelectionTokens(rawText);
  const lowered = rawText.trim().toLowerCase();
  const clearWords = new Set(["all", "全部", "全て", "すべて", "解除", "クリア", "clear"]);

  if (!tokens.length || clearWords.has(lowered)) {
    const payload: DailyTaskSelectionPayload = {
      selectedTaskIds: [],
      raw: rawText,
      timestamp: new Date().toISOString()
    };
    const encoded = JSON.stringify(payload);
    await sessionRepository.appendDailyTaskSelection(session.sessionId, userId, encoded);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "daily_task_selection",
      content: encoded,
      timestamp: payload.timestamp
    });
    return { selectedTaskIds: [] as string[], invalid: [] as string[], cleared: true };
  }

  const todos = await storage.tasks.listTodos();
  const byId = new Map(todos.map(t => [t.id, t]));
  const picked: string[] = [];
  const invalid: string[] = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      const task = todos[index];
      if (!task) {
        invalid.push(token);
        continue;
      }
      picked.push(task.id);
      continue;
    }

    const task = byId.get(token);
    if (!task) {
      invalid.push(token);
      continue;
    }
    picked.push(task.id);
  }

  const unique = [...new Set(picked)].filter(Boolean);
  const payload: DailyTaskSelectionPayload = {
    selectedTaskIds: unique,
    raw: rawText,
    timestamp: new Date().toISOString()
  };
  const encoded = JSON.stringify(payload);
  await sessionRepository.appendDailyTaskSelection(session.sessionId, userId, encoded);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "daily_task_selection",
    content: encoded,
    timestamp: payload.timestamp
  });

  return { selectedTaskIds: unique, invalid, cleared: false };
}

function extractDailyTaskSelectionCommand(userText: string) {
  const trimmed = (userText || "").trim();
  const m = trimmed.match(/^(report|対象|日報対象)\s*(?::|：)?\s*(.*)$/i);
  if (!m) return null;
  return (m[2] ?? "").trim();
}

function extractDailyStartSelection(userText: string) {
  if (!userText.startsWith(DAILY_START_KEYWORD)) return null;
  const rest = userText.slice(DAILY_START_KEYWORD.length).trim();
  return rest || null;
}

function sanitizePriority(value?: string) {
  const normalized = sanitizeString(value).toUpperCase();
  return ["A", "B", "C"].includes(normalized) ? normalized : "";
}

type RawDailyReviewTask = {
  description?: string;
  priority?: string;
  due_date?: string;
  dueDate?: string;
};

type RawDailyReview = {
  evaluation?: string;
  tomorrow_focus?: unknown;
  tomorrowFocus?: unknown;
  task_review?: unknown;
  taskReview?: unknown;
  follow_up_tasks?: unknown;
  followUpTasks?: unknown;
};

function normalizeDailyReviewTasks(raw: RawDailyReviewTask[] | undefined): DailyReviewTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(task => ({
      description: sanitizeString(task.description),
      priority: sanitizePriority(task.priority) || "B",
      dueDate: sanitizeString(task.due_date ?? task.dueDate)
    }))
    .filter(task => task.description.length > 0)
    .slice(0, 5);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => sanitizeString(String(item))).filter(Boolean).slice(0, 3);
}

function normalizeTaskReview(value: unknown): DailyReviewResult["taskReview"] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      return {
        taskId: sanitizeString(String(obj.taskId ?? "")),
        action: sanitizeString(String(obj.action ?? "")),
        recommendation: sanitizeString(String(obj.recommendation ?? "")),
        newDueDate: sanitizeString(String(obj.new_due_date ?? obj.newDueDate ?? "")),
        newPriority: sanitizePriority(String(obj.new_priority ?? obj.newPriority ?? "")),
        reason: sanitizeString(String(obj.reason ?? ""))
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> =>
        !!item && Boolean(item.recommendation || item.reason || item.taskId || item.action)
    )
    .slice(0, 5);
}

function parseDailyReviewResponse(text: string): DailyReviewResult | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as RawDailyReview;
    const tomorrow = toStringArray(parsed.tomorrow_focus ?? parsed.tomorrowFocus);
    const taskReview = normalizeTaskReview(parsed.task_review ?? parsed.taskReview);
    const followUps = normalizeDailyReviewTasks(
      (parsed.follow_up_tasks ?? parsed.followUpTasks) as RawDailyReviewTask[] | undefined
    );
    return {
      evaluation: sanitizeString(parsed.evaluation),
      tomorrowFocus: tomorrow,
      taskReview,
      followUpTasks: followUps
    };
  } catch {
    return null;
  }
}

function safeJsonStringify(value: unknown, maxLen = 20000): string {
  let s = "";
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…(truncated ${s.length - maxLen} chars)`;
}

function parseDailyReviewStoredPayload(payload: string): DailyReviewStoredPayload | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<DailyReviewStoredPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    const dailyLogId = sanitizeString(parsed.dailyLogId);
    const generatedAt = sanitizeString(parsed.generatedAt);
    const review = parsed.review as DailyReviewResult | undefined;
    if (!dailyLogId || !review) return null;
    return { dailyLogId, generatedAt, review };
  } catch {
    return null;
  }
}

function extractDailyRescheduleTarget(userText: string): string | null {
  if (!userText.startsWith(DAILY_RESCHEDULE_COMMAND)) return null;
  const rest = userText.slice(DAILY_RESCHEDULE_COMMAND.length).trim();
  return rest || null; // dailyLogId を想定（省略なら最新）
}

function buildRescheduledTaskDescription(original: string) {
  const trimmed = (original || "").trim();
  if (!trimmed) return "（再スケジュール）";
  if (trimmed.includes("再スケジュール")) return trimmed;
  return `${trimmed}（再スケジュール）`;
}

async function handleDailyRescheduleCommand(userId: string, replyToken: string, userText: string) {
  const target = extractDailyRescheduleTarget(userText); // dailyLogId or null(latest)
  const active = await sessionRepository.getActiveSession(userId);
  if (active) {
    await replyText(
      replyToken,
      `まだ別モードが動いている。「${isDailySession(active) ? DAILY_END_KEYWORD : LOG_END_KEYWORD}」で終わらせろ。`
    );
    return NextResponse.json({ ok: true, note: "session_already_active" });
  }

  const sessions = await sessionRepository.listSessions(userId);
  const candidates = sessions
    .filter(s => SessionRepository.getSessionMode(s) === "daily")
    .slice()
    .reverse();

  let found: { sessionId: string; payload: DailyReviewStoredPayload; alreadyApplied: boolean } | null = null;
  for (const s of candidates) {
    const reviewEvent = [...s.events].reverse().find(e => e.type === "daily_review");
    if (!reviewEvent) continue;
    const parsed = parseDailyReviewStoredPayload(reviewEvent.content);
    if (!parsed) continue;
    if (target && parsed.dailyLogId !== target) continue;
    const alreadyApplied = s.events.some(e => e.type === "daily_review_apply" && e.content.includes(parsed.dailyLogId));
    found = { sessionId: s.sessionId, payload: parsed, alreadyApplied };
    break;
  }

  if (!found) {
    await replyText(
      replyToken,
      target
        ? `指定された日報ログID「${target}」の再スケジュール提案が見つからない。`
        : "直近の日報の再スケジュール提案が見つからない。先に日報を締めろ。"
    );
    return NextResponse.json({ ok: true, note: "daily_review_not_found" });
  }

  if (found.alreadyApplied) {
    await replyText(
      replyToken,
      `その日報（${found.payload.dailyLogId}）の再スケジュールは既に作成済みだ。二重作成はしない。`
    );
    return NextResponse.json({ ok: true, note: "daily_review_already_applied" });
  }

  const rescheduleItems = (found.payload.review.taskReview || []).filter(
    item => (item.action || "").toLowerCase() === "reschedule" && (item.taskId || "").trim()
  );
  if (!rescheduleItems.length) {
    await replyText(replyToken, "再スケジュール対象が提案に含まれていない。");
    return NextResponse.json({ ok: true, note: "no_reschedule_items" });
  }

  const created: TaskRecord[] = [];
  const createdIds: string[] = [];
  const timestamp = new Date().toISOString();

  for (const item of rescheduleItems) {
    const original = await storage.tasks.findById(item.taskId);
    if (!original) continue;

    const task: TaskRecord = {
      id: buildFollowUpTaskId(),
      goalId: original.goalId || "",
      description: buildRescheduledTaskDescription(original.description),
      status: "todo",
      dueDate: item.newDueDate || "",
      priority: (item.newPriority || original.priority || "B").toUpperCase(),
      assignedAt: timestamp,
      sourceLogId: found.payload.dailyLogId
    };
    await storage.tasks.add(task);
    created.push(task);
    createdIds.push(task.id);
  }

  await sessionRepository.appendDailyReviewApply(
    found.sessionId,
    userId,
    safeJsonStringify({
      dailyLogId: found.payload.dailyLogId,
      appliedAt: timestamp,
      createdTaskIds: createdIds
    } satisfies DailyReviewApplyPayload)
  );

  if (!created.length) {
    await replyText(replyToken, "再スケジュールタスクを作成できなかった（元タスクが見つからない可能性）。");
    return NextResponse.json({ ok: true, note: "reschedule_create_failed" });
  }

  const lines = ["再スケジュールタスクを作成した:", ...created.map(t => {
    const due = t.dueDate ? ` (期限:${t.dueDate})` : "";
    return `- ${t.id} [${t.priority || "B"}] ${t.description}${due}`;
  })];
  await replyText(replyToken, lines.join("\n"));
  return NextResponse.json({ ok: true, mode: "daily_reschedule_create", dailyLogId: found.payload.dailyLogId });
}

function extractTaskCommandTarget(userText: string) {
  if (!userText.startsWith(TASK_SUMMARY_COMMAND)) {
    return null;
  }
  const rest = userText.slice(TASK_SUMMARY_COMMAND.length).trim();
  if (!rest || rest === "latest") {
    return null;
  }
  return rest;
}

function hasAnalysisEvent(session: SessionTranscript) {
  return session.events.some(event => event.type === "analysis");
}

async function handleSessionStart(userId: string, replyToken: string) {
  const existing = await sessionRepository.getActiveSession(userId);
  if (existing) {
    await replyText(
      replyToken,
      `まだ別モードが動いている。「${LOG_END_KEYWORD}」か「${DAILY_END_KEYWORD}」で終わらせろ。`
    );
    return NextResponse.json({ ok: true, mode: "session_already_active" });
  }

  await sessionRepository.start(userId, "log");
  await replyText(
    replyToken,
    [
      "思考ログモード開始。",
      "",
      "今、何が気になってる？",
      "ふわっとした気持ちでいい。そのまま送って。",
      "",
      `終了: ${LOG_END_KEYWORD}`,
      `タスク化: ${TASK_SUMMARY_COMMAND}`
    ].join("\n")
  );

  return NextResponse.json({ ok: true, mode: "session_start" });
}

async function handleSessionEnd(userId: string, replyToken: string) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    await replyText(
      replyToken,
      `まだ思考ログは始まっていない。「${LOG_START_KEYWORD}」を先に送れ。`
    );
    return NextResponse.json({ ok: true, note: "session_not_found" });
  }

  if (!isLogSession(session)) {
    await replyText(
      replyToken,
      `今は日報モード中だ。「${DAILY_END_KEYWORD}」で終えてから使え。`
    );
    return NextResponse.json({ ok: true, note: "session_not_log" });
  }

  const transcript = buildConversationTranscript(session.events);
  if (!transcript) {
    await sessionRepository.end(session.sessionId, userId, "empty_transcript");
    await replyText(
      replyToken,
      "ログが空だった。思考を一度も送っていないので記録は作れない。"
    );
    return NextResponse.json({ ok: true, note: "empty_transcript" });
  }

  await sessionRepository.end(session.sessionId, userId, "log_recorded");
  await replyText(
    replyToken,
    [
      "思考の整理、お疲れ様。",
      "",
      "今の気持ちを言語化できたね。",
      `次に「${TASK_SUMMARY_COMMAND}」を送れば、ここから具体的なタスクを作れる。`
    ].join("\n")
  );

  return NextResponse.json({ ok: true, mode: "session_end_waiting_analysis" });
}

async function handleTaskSummaryCommand(
  userId: string,
  replyToken: string,
  userText: string
) {
  const targetSessionId = extractTaskCommandTarget(userText);
  const sessions = await sessionRepository.listSessions(userId);
  const logSessions = sessions.filter(
    session => isLogSession(session) && session.events.some(event => event.type === "end")
  );

  if (!logSessions.length) {
    await replyText(
      replyToken,
      `解析済みのログがない。まず「${LOG_START_KEYWORD} → ${LOG_END_KEYWORD}」で思考を流せ。`
    );
    return NextResponse.json({ ok: true, note: "log_not_found" });
  }

  let target: SessionTranscript | null = null;
  if (targetSessionId) {
    target = logSessions.find(session => session.sessionId === targetSessionId) ?? null;
    if (!target) {
      await replyText(replyToken, `指定したセッションID「${targetSessionId}」は見つからない。`);
      return NextResponse.json({ ok: true, note: "session_not_found" });
    }
  } else {
    const pending = logSessions.filter(session => !hasAnalysisEvent(session));
    target = (pending.length ? pending : logSessions)[pending.length ? pending.length - 1 : logSessions.length - 1];
  }

  if (!target) {
    await replyText(replyToken, "対象のログが決められなかった。");
    return NextResponse.json({ ok: true, note: "session_not_available" });
  }

  if (hasAnalysisEvent(target)) {
    await replyText(
      replyToken,
      [
        "そのログはすでにタスク化済みだ。",
        targetSessionId
          ? "別のセッションIDを指定するか、新しいログを作成しろ。"
          : "最新の未処理ログは存在しない。新しく記録しろ。"
      ].join("\n")
    );
    return NextResponse.json({ ok: true, note: "session_already_analyzed" });
  }

  const transcript = buildConversationTranscript(target.events);
  if (!transcript) {
    await replyText(replyToken, "対象ログにユーザーメッセージがなかった。新しくやり直せ。");
    return NextResponse.json({ ok: true, note: "empty_transcript" });
  }

  const result = await goalIntakeService.handle({ userId, text: transcript });
  await sessionRepository.markAnalyzed(target.sessionId, userId, result.logId);
  const reply = goalIntakeService.buildReplyMessage(result);
  await replyText(
    replyToken,
    [reply, "", `このログID: ${result.logId}`, `日報に移るなら「${DAILY_START_KEYWORD}」と送れ。`].join(
      "\n"
    )
  );

  return NextResponse.json({ ok: true, mode: "task_summary", logId: result.logId });
}

async function handleDailyStart(userId: string, replyToken: string, userText: string) {
  const existing = await sessionRepository.getActiveSession(userId);
  if (existing) {
    await replyText(
      replyToken,
      `別モードが動いている。「${isDailySession(existing) ? DAILY_END_KEYWORD : LOG_END_KEYWORD}」で終わらせろ。`
    );
    return NextResponse.json({ ok: true, note: "session_already_active" });
  }

  const session = await sessionRepository.start(userId, "daily");
  const selection = extractDailyStartSelection(userText);
  let selectionNote = "";
  const todos = await storage.tasks.listTodos();
  let displayTodos = todos;

  if (selection) {
    const applied = await applyDailyTaskSelectionFromText(session, userId, selection);
    if (applied.cleared) {
      selectionNote = "日報対象は未指定（todo全件）にした。";
      displayTodos = todos;
    } else if (!applied.selectedTaskIds.length) {
      selectionNote = "指定された日報対象が見つからない。いったんtodo全件を出す。";
      displayTodos = todos;
    } else {
      const selectedSet = new Set(applied.selectedTaskIds);
      displayTodos = todos.filter(t => selectedSet.has(t.id));
      selectionNote = `日報対象を ${applied.selectedTaskIds.length} 件に絞った。`;
      if (applied.invalid.length) {
        selectionNote += `（無効: ${applied.invalid.join(", ")}）`;
      }
    }
  }

  // 日報開始時は優先度の高い2-3件のみ表示（見やすさ重視）
  const INITIAL_DISPLAY_LIMIT = 3;
  const taskListMessage = await buildDailyTaskListMessage(
    displayTodos,
    selection ? "日報対象タスク" : "本日の焦点",
    todos,
    INITIAL_DISPLAY_LIMIT
  );
  
  // メッセージを分割して見やすく
  const messages = [
    [
      "【日報】開始",
      selectionNote ? `※${selectionNote}` : null,
      `終了: ${DAILY_END_KEYWORD}`
    ].filter(Boolean).join("\n"),
    
    taskListMessage,
    
    [
      "【報告方法】",
      "✅完了: done 1",
      "❌未達: miss 2 理由",
      "📝メモ: その他は全てメモ",
      "",
      "🔄一覧: list（全件表示）",
      "🎯対象: 対象 1,3（絞込）"
    ].join("\n")
  ];

  await replyTexts(replyToken, messages);
  return NextResponse.json({ ok: true, mode: "daily_start", sessionId: session.sessionId });
}

async function recordDailyUpdate(
  session: SessionTranscript,
  userId: string,
  update: DailyUpdateRecord
) {
  const payload = JSON.stringify(update);
  await sessionRepository.appendDailyUpdate(session.sessionId, userId, payload);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "daily_update",
    content: payload,
    timestamp: update.timestamp
  });
}

async function tryHandleFeedbackResponse(userId: string, replyToken: string, userText: string, session: SessionTranscript) {
  // フィードバック待ち状態をチェック
  const feedbackEvent = [...session.events]
    .reverse()
    .find(e => e.type === "user" && e.content.includes("feedback_pending"));
  
  if (!feedbackEvent) return false;
  
  let feedbackData: { taskId: string; timestamp: string } | null = null;
  try {
    feedbackData = JSON.parse(feedbackEvent.content);
  } catch {
    return false;
  }
  
  if (!feedbackData) return false;
  
  // フィードバック応答の判定
  const normalized = userText.trim();
  let satisfied: boolean | null = null;
  
  if (/^(👍|よかった|良かった|適切|OK|ok)$/i.test(normalized)) {
    satisfied = true;
  } else if (/^(👎|別のがよかった|別の|不適切|NG|ng)$/i.test(normalized)) {
    satisfied = false;
  } else if (/^(⏭️|スキップ|skip|後で)$/i.test(normalized)) {
    await reply(replyToken, "了解。フィードバックはスキップした。", userId);
    return true;
  } else {
    return false; // フィードバック応答ではない
  }
  
  // フィードバックを記録（将来的にFeedbackServiceに保存）
  await sessionRepository.appendUserMessage("task_feedback", userId, JSON.stringify({
    taskId: feedbackData.taskId,
    satisfied,
    timestamp: new Date().toISOString()
  }));
  
  if (satisfied) {
    await reply(
      replyToken,
      [
        "👍 ありがとう。",
        "AIのタスク選定に反映する。",
        "",
        "続けて報告するか、今日はここまでにするか選んで。"
      ].join("\n"),
      userId
    );
  } else {
    await reply(
      replyToken,
      [
        "👎 了解。",
        "次回はより適切なタスクを選ぶ。",
        "",
        "どんなタスクがよかった？（任意で教えて）",
        "または「スキップ」で次に進む。"
      ].join("\n"),
      userId
    );
  }
  
  return true;
}

async function handleDailyMessage(
  userId: string,
  replyToken: string,
  userText: string,
  session: SessionTranscript
) {
  // フィードバック応答のチェック（最優先）
  const feedbackHandled = await tryHandleFeedbackResponse(userId, replyToken, userText, session);
  if (feedbackHandled) {
    return NextResponse.json({ ok: true, mode: "feedback_recorded" });
  }
  
  const selectionCommand = extractDailyTaskSelectionCommand(userText);
  if (selectionCommand !== null) {
    const applied = await applyDailyTaskSelectionFromText(session, userId, selectionCommand);
    const { todos, selectedIds } = await resolveDisplayedTodoList(session);
    const selectedSet = new Set(selectedIds);
    const display = selectedIds.length ? todos.filter(t => selectedSet.has(t.id)) : todos;
    const title = selectedIds.length ? "日報対象タスク" : "未着手タスク一覧";
    const note = applied.cleared
      ? "🔄対象解除（全件表示）"
      : applied.selectedTaskIds.length
        ? `🎯対象設定（${applied.selectedTaskIds.length}件）`
        : "⚠️対象が見つからない（全件表示）";
    const invalidLine = applied.invalid.length ? `無効: ${applied.invalid.join(", ")}` : "";
    
    const messages = [
      [note, invalidLine].filter(Boolean).join("\n"),
      await buildDailyTaskListMessage(display, title, todos)
    ];
    await replyTexts(replyToken, messages);
    return NextResponse.json({ ok: true, mode: "daily_task_selection" });
  }

  if (/^(list|一覧)$/i.test(userText.trim())) {
    const { todos, displayed, selectedIds } = await resolveDisplayedTodoList(session);
    if (!selectedIds.length) {
      const messages = [
        await buildDailyTaskListMessage(todos, "未着手タスク一覧", todos),
        "報告: done 1 / miss 2 理由"
      ];
      await replyTexts(replyToken, messages);
      return NextResponse.json({ ok: true, mode: "daily_list" });
    }
    const messages = [
      await buildDailyTaskListMessage(displayed, "日報対象タスク", todos),
      [
        "報告: done 1 / miss 2 理由",
        "解除: 対象 全部",
        "※番号は全件基準"
      ].join("\n")
    ];
    await replyTexts(replyToken, messages);
    return NextResponse.json({ ok: true, mode: "daily_list" });
  }

  await sessionRepository.appendUserMessage(session.sessionId, userId, userText);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "user",
    content: userText,
    timestamp: new Date().toISOString()
  });

  // 正しい形式: done 1 / miss 2 理由
  const doneMatch = userText.match(/^(done|完了)\s+(\S+)$/i);
  const missMatch = userText.match(/^(miss|未達)\s+(\S+)(?:\s+(.+))?$/i);
  const noteMatch = userText.match(/^(note|メモ)\s+(.+)/i);
  
  // 間違った形式の検知（逆順）
  const reverseDoneMatch = userText.match(/^(\S+)\s+(done|完了)$/i);
  const reverseMissMatch = userText.match(/^(\S+)\s+(miss|未達)(?:\s+(.+))?$/i);

  const resolveTaskId = async (raw: string) => {
    const token = (raw || "").trim();
    if (!token) return null;
    if (!/^\d+$/.test(token)) return token;
    const displayed = await storage.tasks.listTodos();
    const idx = Number(token) - 1;
    const task = displayed[idx];
    return task?.id ?? null;
  };

  // 間違った形式（逆順）のチェック
  if (reverseDoneMatch) {
    const target = reverseDoneMatch[1];
    await replyText(
      replyToken,
      [
        `⚠️形式が間違っている: ${userText}`,
        "",
        "正しい形式:",
        `done ${target}`,
        "",
        "理由: タスクIDは t_ から始まるので、",
        "番号とIDを混同しないよう、動詞を先に書く。"
      ].join("\n")
    );
    return NextResponse.json({ ok: true, note: "wrong_format_reverse_done" });
  }

  if (reverseMissMatch) {
    const target = reverseMissMatch[1];
    const reason = reverseMissMatch[3] || "";
    await replyText(
      replyToken,
      [
        `⚠️形式が間違っている: ${userText}`,
        "",
        "正しい形式:",
        reason ? `miss ${target} ${reason}` : `miss ${target}`,
        "",
        "理由: タスクIDは t_ から始まるので、",
        "番号とIDを混同しないよう、動詞を先に書く。"
      ].join("\n")
    );
    return NextResponse.json({ ok: true, note: "wrong_format_reverse_miss" });
  }

  if (doneMatch) {
    const rawTarget = doneMatch[2];
    const taskId = await resolveTaskId(rawTarget);
    if (!taskId) {
      await replyText(replyToken, `番号「${rawTarget}」に該当するタスクがない。list/対象で一覧を確認しろ。`);
      return NextResponse.json({ ok: true, note: "task_not_found" });
    }
    const task = await storage.tasks.findById(taskId);
    if (!task) {
      await replyText(replyToken, `タスクID「${taskId}」は見つからない。IDを再確認しろ。`);
      return NextResponse.json({ ok: true, note: "task_not_found" });
    }

    // 更新を試行し、結果を検証
    let updateSuccess = false;
    try {
      updateSuccess = await storage.tasks.updateStatus(taskId, "done");
    } catch (error) {
      console.error("[daily_done] updateStatus failed", { taskId, error: (error as Error)?.message });
      await replyText(
        replyToken,
        [
          `完了登録に失敗した: ${task.description}`,
          "ストレージエラーが発生した。もう一度試すか、管理者に連絡しろ。",
          `対象タスクID: ${taskId}`
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "storage_error", taskId, error: (error as Error)?.message });
    }

    if (!updateSuccess) {
      console.warn("[daily_done] updateStatus returned false", { taskId });
      await replyText(
        replyToken,
        [
          `完了登録に失敗した: ${task.description}`,
          "タスクが見つからないか、すでに更新されている可能性がある。",
          `もう一度 list で確認してから done ${taskId} を送れ。`
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "update_failed", taskId });
    }

    // 更新後の状態を確認
    const updated = await storage.tasks.findById(taskId);
    if (updated && updated.status !== "done") {
      console.error("[daily_done] status verification failed", {
        taskId,
        expectedStatus: "done",
        actualStatus: updated.status
      });
      await replyText(
        replyToken,
        [
          `完了登録の検証に失敗した: ${task.description}`,
          `期待: done / 実際: ${updated.status}`,
          "ストレージの整合性に問題がある可能性がある。管理者に連絡しろ。"
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "verification_failed", taskId, actualStatus: updated.status });
    }

    const timestamp = new Date().toISOString();
    await recordDailyUpdate(session, userId, { taskId, status: "done", timestamp });
    
    // モチベーション向上: ランダムな褒め言葉
    const praises = [
      "よくやった！",
      "素晴らしい！",
      "いい調子だ！",
      "その調子！",
      "完璧だ！",
      "やるじゃないか！"
    ];
    const praise = praises[Math.floor(Math.random() * praises.length)];
    const doneMessage = `✅ ${praise}\n${task.description}`;
    
    await sessionRepository.appendAssistantMessage(session.sessionId, userId, doneMessage);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "assistant",
      content: doneMessage,
      timestamp
    });
    console.log("[daily_done] success", { taskId, description: task.description });
    
    // 次タスク案内（モチベーション向上）
    const { todos, displayed } = await resolveDisplayedTodoList(session);
    const remainingTodos = displayed.filter(t => t.id !== taskId); // 今完了したタスクを除外
    
    const messages = [doneMessage];
    
    // フィードバック収集（朝の命令タスクの場合のみ）
    const morningTaskId = await sessionRepository.findLatestMorningOrderTaskId(userId);
    if (morningTaskId === taskId) {
      // 朝のAIが選んだタスクを完了した場合、満足度を聞く
      const feedbackMessage = [
        "",
        "💭 このタスクは適切でしたか？",
        "👍 よかった",
        "👎 別のがよかった",
        "⏭️ スキップ（後で答える）"
      ].join("\n");
      messages.push(feedbackMessage);
      
      // フィードバック待ち状態を保存
      await sessionRepository.appendUserMessage("feedback_pending", userId, JSON.stringify({
        taskId,
        timestamp: new Date().toISOString()
      }));
    } else if (remainingTodos.length > 0) {
      // 朝のタスクではない場合は次タスク案内
      const nextTask = remainingTodos[0];
      const nextIndex = todos.findIndex(t => t.id === nextTask.id);
      const displayNumber = nextIndex >= 0 ? nextIndex + 1 : "?";
      const priority = nextTask.priority || "-";
      
      const nextMessages = [
        "💪 もう1件いける？",
        "",
        `次のタスク:`,
        `${displayNumber}) [${priority}] ${nextTask.description}`,
        "",
        `やるなら: done ${displayNumber}`,
        `今日はここまで: ${DAILY_END_KEYWORD}`
      ];
      messages.push(nextMessages.join("\n"));
    } else {
      // 全タスク完了！
      messages.push(
        [
          "",
          "🎉 全タスク完了！",
          `今日の報告を締めるなら: ${DAILY_END_KEYWORD}`
        ].join("\n")
      );
    }
    
    await replyTexts(replyToken, messages);
    return NextResponse.json({ ok: true, mode: "daily_done", taskId });
  }

  if (missMatch) {
    const rawTarget = missMatch[2];
    const taskId = await resolveTaskId(rawTarget);
    if (!taskId) {
      await replyText(replyToken, `番号「${rawTarget}」に該当するタスクがない。list/対象で一覧を確認しろ。`);
      return NextResponse.json({ ok: true, note: "task_not_found" });
    }
    const reason = (missMatch[3] || "").trim();
    const task = await storage.tasks.findById(taskId);
    if (!task) {
      await replyText(replyToken, `タスクID「${taskId}」は見つからない。IDを再確認しろ。`);
      return NextResponse.json({ ok: true, note: "task_not_found" });
    }

    // 更新を試行し、結果を検証
    let updateSuccess = false;
    try {
      updateSuccess = await storage.tasks.updateStatus(taskId, "miss");
    } catch (error) {
      console.error("[daily_miss] updateStatus failed", { taskId, error: (error as Error)?.message });
      await replyText(
        replyToken,
        [
          `未達登録に失敗した: ${task.description}`,
          "ストレージエラーが発生した。もう一度試すか、管理者に連絡しろ。",
          `対象タスクID: ${taskId}`
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "storage_error", taskId, error: (error as Error)?.message });
    }

    if (!updateSuccess) {
      console.warn("[daily_miss] updateStatus returned false", { taskId });
      await replyText(
        replyToken,
        [
          `未達登録に失敗した: ${task.description}`,
          "タスクが見つからないか、すでに更新されている可能性がある。",
          `もう一度 list で確認してから miss ${taskId} 理由 を送れ。`
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "update_failed", taskId });
    }

    // 更新後の状態を確認
    const updated = await storage.tasks.findById(taskId);
    if (updated && updated.status !== "miss") {
      console.error("[daily_miss] status verification failed", {
        taskId,
        expectedStatus: "miss",
        actualStatus: updated.status
      });
      await replyText(
        replyToken,
        [
          `未達登録の検証に失敗した: ${task.description}`,
          `期待: miss / 実際: ${updated.status}`,
          "ストレージの整合性に問題がある可能性がある。管理者に連絡しろ。"
        ].join("\n")
      );
      return NextResponse.json({ ok: false, note: "verification_failed", taskId, actualStatus: updated.status });
    }

    const timestamp = new Date().toISOString();
    await recordDailyUpdate(session, userId, { taskId, status: "miss", note: reason, timestamp });
    
    // モチベーション向上: 前向きなフィードバック
    const encouragements = [
      "大丈夫。次がある。",
      "気にするな。明日がんばろう。",
      "問題ない。次につなげよう。",
      "OK。次のチャンスで取り返せる。",
      "了解。次はやれる。"
    ];
    const encouragement = encouragements[Math.floor(Math.random() * encouragements.length)];
    
    // 次のアクション提案（新機能）
    const suggestions = [
      "",
      "💡 次のアクション:",
      "1️⃣ 明日もう一度挑戦する",
      "2️⃣ タスクを小さく分割する",
      "3️⃣ 優先度を下げて別の日にする",
      "",
      "どうする？（後で決めてもOK）"
    ];
    
    const message = [
      `❌ 未達（${encouragement}）`,
      task.description,
      reason ? `理由: ${reason}` : "",
      "",
      ...suggestions
    ].filter(Boolean).join("\n");
    
    await sessionRepository.appendAssistantMessage(session.sessionId, userId, message);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "assistant",
      content: message,
      timestamp
    });
    console.log("[daily_miss] success", { taskId, description: task.description, reason });
    await replyText(replyToken, message);
    return NextResponse.json({ ok: true, mode: "daily_miss", taskId });
  }

  const noteText = noteMatch ? noteMatch[2] : userText;
  const timestamp = new Date().toISOString();
  await recordDailyUpdate(session, userId, { taskId: "メモ", status: "note", note: noteText, timestamp });
  const message = "📝メモ記録";
  await sessionRepository.appendAssistantMessage(session.sessionId, userId, message);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "assistant",
    content: message,
    timestamp
  });
  await replyText(replyToken, message);
  return NextResponse.json({ ok: true, mode: "daily_note" });
}

function calculateStreak(logs: { id: string; timestamp: string }[]): number {
  if (!logs.length) return 0;
  
  // 日報ログのみ抽出（daily_ で始まる）
  const dailyLogs = logs
    .filter(log => log.id.startsWith("daily_"))
    .map(log => new Date(log.timestamp))
    .sort((a, b) => b.getTime() - a.getTime()); // 新しい順
  
  if (!dailyLogs.length) return 0;
  
  let streak = 1; // 今日分
  let currentDate = new Date(dailyLogs[0]);
  currentDate.setHours(0, 0, 0, 0);
  
  for (let i = 1; i < dailyLogs.length; i++) {
    const logDate = new Date(dailyLogs[i]);
    logDate.setHours(0, 0, 0, 0);
    
    const prevDate = new Date(currentDate);
    prevDate.setDate(prevDate.getDate() - 1);
    
    if (logDate.getTime() === prevDate.getTime()) {
      streak++;
      currentDate = logDate;
    } else {
      break; // 連続が途切れた
    }
  }
  
  return streak;
}

function checkMilestones(streak: number, totalDone: number): string[] {
  const badges: string[] = [];
  
  // ストリークバッジ
  if (streak >= 100) {
    badges.push("🏆 レジェンド（100日連続）");
  } else if (streak >= 50) {
    badges.push("💎 ダイヤモンド（50日連続）");
  } else if (streak >= 30) {
    badges.push("🥇 ゴールド（30日連続）");
  } else if (streak >= 14) {
    badges.push("🥈 シルバー（14日連続）");
  } else if (streak >= 7) {
    badges.push("🥉 ブロンズ（7日連続）");
  } else if (streak >= 3) {
    badges.push("🔥 3日連続達成");
  }
  
  // 完了件数バッジ
  if (totalDone >= 1000) {
    badges.push("🌟 マスター（1000件完了）");
  } else if (totalDone >= 500) {
    badges.push("⭐ エキスパート（500件完了）");
  } else if (totalDone >= 300) {
    badges.push("✨ プロ（300件完了）");
  } else if (totalDone >= 100) {
    badges.push("💪 百人力（100件完了）");
  } else if (totalDone >= 50) {
    badges.push("🎯 ハンター（50件完了）");
  } else if (totalDone >= 10) {
    badges.push("🌱 初心者卒業（10件完了）");
  }
  
  return badges;
}

async function handleDailyEnd(userId: string, replyToken: string) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    await replyText(
      replyToken,
      `日報モードは動いていない。「${DAILY_START_KEYWORD}」で開始しろ。`
    );
    return NextResponse.json({ ok: true, note: "daily_not_found" });
  }

  if (!isDailySession(session)) {
    await replyText(
      replyToken,
      `今は思考ログモードだ。「${LOG_END_KEYWORD}」で締めてから使え。`
    );
    return NextResponse.json({ ok: true, note: "daily_wrong_mode" });
  }

  const updates = collectDailyUpdates(session);
  const summary = buildDailySummary(updates);
  
  // 進捗集計（モチベーション向上）
  const doneCount = updates.filter(u => u.status === "done").length;
  const missCount = updates.filter(u => u.status === "miss").length;
  const totalCount = doneCount + missCount;
  
  await sessionRepository.end(session.sessionId, userId, "daily_report");

  const dailyLogId = buildDailyLogId();

  if (updates.length) {
    await storage.logs.add({
      id: dailyLogId,
      timestamp: new Date().toISOString(),
      userId,
      rawText: summary,
      emotion: "",
      coreIssue: "",
      currentGoal: "",
      todayTask: "",
      warning: ""
    });
  }

  let review: DailyReviewResult | null = null;
  let createdTasks: TaskRecord[] = [];
  if (updates.length) {
    try {
      const remainingTodos = await storage.tasks.listTodos();
      const remainingMessage = await buildDailyTaskListMessage(remainingTodos, "未着手タスク一覧", remainingTodos);
      const prompt = buildDailyReviewPrompt(summary, remainingMessage);
      const aiRaw = await callDeepSeek(SYSTEM_PROMPT, prompt);
      review = parseDailyReviewResponse(aiRaw || "");

      if (review) {
        await sessionRepository.appendDailyReview(
          session.sessionId,
          userId,
          safeJsonStringify({
            dailyLogId,
            generatedAt: new Date().toISOString(),
            review
          } satisfies DailyReviewStoredPayload)
        );
      }

      if (review?.followUpTasks?.length) {
        const timestamp = new Date().toISOString();
        for (const followUp of review.followUpTasks) {
          const task: TaskRecord = {
            id: buildFollowUpTaskId(),
            goalId: "",
            description: followUp.description,
            status: "todo",
            dueDate: followUp.dueDate,
            priority: (followUp.priority || "B").toUpperCase(),
            assignedAt: timestamp,
            sourceLogId: dailyLogId
          };
          await storage.tasks.add(task);
          createdTasks.push(task);
        }
      }
    } catch (err) {
      // 日報の締め処理自体は止めない（AI/外部API失敗は握りつぶして要約だけ返す）
      console.warn("[daily_review][skip]", { message: (err as Error)?.message });
      review = null;
      createdTasks = [];
    }
  }

  const replyLines: string[] = [];
  
  // ストリーク計算（モチベーション向上）
  const recentLogs = await storage.logs.listRecent(30, 100);
  const streak = calculateStreak(recentLogs);
  
  // 全タスクから完了件数を計算
  const allTasks = await storage.tasks.listAll();
  const totalDone = allTasks.filter(t => t.status.toLowerCase() === "done").length;
  
  // マイルストーン・バッジチェック
  const badges = checkMilestones(streak, totalDone);
  
  // モチベーション向上: 進捗サマリー
  if (totalCount > 0) {
    const ratio = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    if (doneCount === totalCount) {
      replyLines.push(`🎉 完璧！全${totalCount}件完了！`);
    } else if (doneCount > 0) {
      replyLines.push(`💪 今日は${doneCount}件完了！（達成率${ratio}%）`);
    } else {
      replyLines.push(`📝 記録OK。明日はできる。`);
    }
    
    // ストリーク表示
    if (streak >= 2) {
      replyLines.push(`🔥 連続${streak}日！`);
    }
    
    // バッジ表示
    if (badges.length > 0) {
      replyLines.push("");
      replyLines.push("【達成バッジ】");
      badges.forEach(badge => replyLines.push(badge));
    }
    
    replyLines.push("");
  }
  
  // ゴール進捗表示（新機能）
  const goalProgress = await listActiveGoalProgress(storage.goals, storage.tasks);
  if (goalProgress.length > 0) {
    replyLines.push("🎯 ゴール進捗:");
    for (const gp of goalProgress.slice(0, 3)) { // 最大3件表示
      const bar = "█".repeat(Math.floor(gp.progressPercent / 10)) + "░".repeat(10 - Math.floor(gp.progressPercent / 10));
      replyLines.push(`${gp.goal.title}: ${bar} ${gp.progressPercent}%`);
    }
    replyLines.push("");
  }
  
  // 学習とパーソナライズ: ユーザーの傾向から提案
  try {
    const suggestions = await learningService.generateSuggestions();
    if (suggestions.length > 0) {
      replyLines.push("💡 AIからの提案:");
      for (const suggestion of suggestions.slice(0, 2)) { // 最大2件表示
        replyLines.push(`・${suggestion.message}`);
      }
      replyLines.push("");
    }
  } catch (err) {
    console.warn("[learning_service][skip]", { message: (err as Error)?.message });
  }
  
  replyLines.push(summary);
  replyLines.push("", `日報ID: ${dailyLogId}`);
  if (review?.evaluation) {
    replyLines.push("", "【評価】", review.evaluation);
  }
  if (review?.tomorrowFocus?.length) {
    replyLines.push("", "【明日の焦点】", ...review.tomorrowFocus.map(line => `- ${line}`));
  }
  if (review?.taskReview?.length) {
    replyLines.push("", "【タスク見直し案】");
    for (const item of review.taskReview) {
      const idPart = item.taskId ? `${item.taskId} ` : "";
      const reasonPart = item.reason ? ` | 根拠: ${item.reason}` : "";
      replyLines.push(`- ${idPart}${item.recommendation}${reasonPart}`.trim());
    }
  }
  if (
    review?.taskReview?.some(item => (item.action || "").toLowerCase() === "reschedule" && (item.taskId || "").trim())
  ) {
    replyLines.push(
      "",
      `再スケジュール案をタスクとして作成するなら「${DAILY_RESCHEDULE_COMMAND}」と送れ。`,
      `特定の日報を指定するなら「${DAILY_RESCHEDULE_COMMAND} ${dailyLogId}」。`
    );
  }
  if (createdTasks.length) {
    replyLines.push("", "【追加した後続タスク】");
    for (const task of createdTasks) {
      const due = task.dueDate ? ` (期限:${task.dueDate})` : "";
      replyLines.push(`- ${task.id} [${task.priority || "B"}] ${task.description}${due}`);
    }
  }

  await replyText(replyToken, replyLines.join("\n"));
  return NextResponse.json({ ok: true, mode: "daily_end" });
}

async function handleInactiveMessage(userId: string, replyToken: string, userText: string) {
  // 番号でモード選択
  if (userText === "1") {
    return handleSessionStart(userId, replyToken);
  }
  if (userText === "2") {
    return handleDailyStart(userId, replyToken, DAILY_START_KEYWORD);
  }
  if (userText === "3") {
    return handleTaskSummaryCommand(userId, replyToken, TASK_SUMMARY_COMMAND);
  }
  
  // AIが自動でモード提案（キーワードベース）
  const lowerText = userText.toLowerCase();
  const thoughtKeywords = ["モヤモヤ", "悩み", "考え", "迷", "不安", "困", "どうしよう", "わからない"];
  const dailyKeywords = ["報告", "完了", "未達", "done", "miss", "やった", "できた", "できなかった"];
  const taskKeywords = ["タスク", "todo", "やること", "整理", "作る", "生成"];
  
  const hasThoughtKeyword = thoughtKeywords.some(k => userText.includes(k));
  const hasDailyKeyword = dailyKeywords.some(k => userText.includes(k));
  const hasTaskKeyword = taskKeywords.some(k => userText.includes(k));
  
  // 思考ログっぽい → 自動で開始
  if (hasThoughtKeyword && !hasDailyKeyword) {
    const session = await sessionRepository.start(userId, "log");
    await sessionRepository.appendUserMessage(session.sessionId, userId, userText);
    
    const thoughtLog = userText;
    const prompt = buildThoughtAnalysisPrompt(thoughtLog);
    const aiRaw = await callDeepSeek(SYSTEM_PROMPT_THOUGHT, prompt);
    const parsedThought = parseThoughtAnalysisResponse(aiRaw || "");
    const aiReplyMessages = buildThoughtReplyMessages(parsedThought, aiRaw || "");
    const aiReplyFull = aiReplyMessages.join("\n---\n");
    
    await sessionRepository.appendAssistantMessage(session.sessionId, userId, aiReplyFull);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "assistant",
      content: aiReplyFull,
      timestamp: new Date().toISOString()
    });
    
    const messages = [
      "思考ログモード自動開始。",
      ...aiReplyMessages,
      `終了: 「終了」と送るか、もっと話す`
    ];
    await replyTexts(replyToken, messages);
    return NextResponse.json({ ok: true, mode: "auto_thought_start" });
  }
  
  // 日報っぽい → 提案
  if (hasDailyKeyword) {
    await replyTextWithQuickReply(
      replyToken,
      "今日の報告をする？",
      [
        { label: "はい", text: "2" },
        { label: "いいえ", text: "?" }
      ]
    );
    return NextResponse.json({ ok: true, note: "daily_suggestion" });
  }
  
  // それ以外 → メニュー表示
  await replyTextWithQuickReply(replyToken, buildInactiveMenuText(), [...buildInactiveMenuButtons()]);
  return NextResponse.json({ ok: true, note: "session_inactive" });
}

async function handleSessionMessage(
  userId: string,
  replyToken: string,
  userText: string
) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    return handleInactiveMessage(userId, replyToken, userText);
  }

  if (!isLogSession(session)) {
    await replyText(
      replyToken,
      `今は日報モードだ。「${DAILY_END_KEYWORD}」で締めてから改めてログを開始しろ。`
    );
    return NextResponse.json({ ok: true, note: "session_wrong_mode" });
  }

  // タスク分割の承認処理
  if (userText === "承認" && session.metadata?.pendingSplit) {
    const { originalTaskId, subTasks } = session.metadata.pendingSplit;
    
    // 元タスクを完了にする
    try {
      await storage.tasks.updateStatus(originalTaskId, "done");
      
      // サブタスクを追加
      const createdSubTasks = [];
      for (const subTask of subTasks) {
        const newTaskId = `t_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        await storage.tasks.add({
          id: newTaskId,
          goalId: "",
          description: subTask.description,
          status: "todo",
          dueDate: "",
          priority: subTask.priority || "B",
          assignedAt: new Date().toISOString(),
          sourceLogId: "",
          reason: subTask.reason || ""
        });
        createdSubTasks.push({ id: newTaskId, ...subTask });
      }
      
      // メタデータをクリア
      delete session.metadata.pendingSplit;
      
      await replyText(
        replyToken,
        [
          "✅ タスク分割を実行した。",
          "",
          `元タスク（${originalTaskId}）を完了にして、`,
          `${createdSubTasks.length}個のサブタスクを追加した。`,
          "",
          "サブタスク:",
          ...createdSubTasks.map((st, i) => `${i + 1}. [${st.priority}] ${st.description}`)
        ].join("\n")
      );
      return NextResponse.json({ ok: true, mode: "split_approved" });
    } catch (error) {
      console.error("split approval error", error);
      await replyText(replyToken, "タスク分割の実行に失敗した。もう一度試してくれ。");
      return NextResponse.json({ ok: false, note: "split_execution_failed" });
    }
  }

  const timestamp = new Date().toISOString();
  await sessionRepository.appendUserMessage(session.sessionId, userId, userText);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "user",
    content: userText,
    timestamp
  });

  const thoughtLog = buildUserThoughtLog(session.events);
  const prompt = buildThoughtAnalysisPrompt(thoughtLog || userText);
  const aiRaw = await callDeepSeek(SYSTEM_PROMPT_THOUGHT, prompt);
  const parsedThought = parseThoughtAnalysisResponse(aiRaw || "");
  const aiReplyMessages = buildThoughtReplyMessages(parsedThought, aiRaw || "");
  const aiReplyFull = aiReplyMessages.join("\n---\n");

  await sessionRepository.appendAssistantMessage(
    session.sessionId,
    userId,
    aiReplyFull
  );
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "assistant",
    content: aiReplyFull,
    timestamp: new Date().toISOString()
  });

  await replyTexts(replyToken, aiReplyMessages);
  return NextResponse.json({ ok: true, mode: "session_chat" });
}

async function handleGoalProgressCommand(userId: string, replyToken: string, goalTitle?: string) {
  const goals = await storage.goals.list();
  const activeGoals = goals.filter(g => g.status !== "archived");
  
  if (activeGoals.length === 0) {
    await reply(
      replyToken,
      [
        "アクティブなゴールはない。",
        "",
        "思考ログでゴールを語れば、AIが自動で作成する。"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, note: "no_active_goals" });
  }
  
  // 特定のゴール指定
  if (goalTitle) {
    const trimmed = goalTitle.trim();
    const goal = activeGoals.find(g => g.title.toLowerCase() === trimmed.toLowerCase());
    
    if (!goal) {
      await reply(
        replyToken,
        [
          `ゴール「${trimmed}」は見つからない。`,
          "",
          "アクティブなゴール一覧:",
          ...activeGoals.map(g => `・${g.title}`)
        ].join("\n"),
        userId
      );
      return NextResponse.json({ ok: true, note: "goal_not_found" });
    }
    
    // 詳細表示 + 予測情報
    const tasks = await storage.tasks.listByGoalId(goal.id);
    const todoTasks = tasks.filter(t => t.status.toLowerCase() === "todo");
    const doneTasks = tasks.filter(t => t.status.toLowerCase() === "done");
    const missTasks = tasks.filter(t => t.status.toLowerCase() === "miss");
    const progressPercent = tasks.length > 0 ? Math.round((doneTasks.length / tasks.length) * 100) : 0;
    const bar = "█".repeat(Math.floor(progressPercent / 10)) + "░".repeat(10 - Math.floor(progressPercent / 10));
    
    const lines = [
      `【ゴール詳細: ${goal.title}】`,
      "",
      `進捗: ${bar} ${progressPercent}%`,
      `完了: ${doneTasks.length}件`,
      `未着手: ${todoTasks.length}件`,
      `未達: ${missTasks.length}件`
    ];
    
    // 予測情報を追加
    try {
      const prediction = await predictionService.predictGoalCompletion(goal.id);
      if (prediction) {
        lines.push("");
        lines.push("📊 **達成予測:**");
        if (prediction.estimatedCompletionDate) {
          lines.push(`完了予定: ${prediction.estimatedCompletionDate} (約${prediction.weeksToCompletion}週間後)`);
        }
        lines.push(`週あたりペース: ${prediction.averageTasksPerWeek.toFixed(1)}タスク`);
        lines.push(`信頼度: ${prediction.confidence === "high" ? "高" : prediction.confidence === "medium" ? "中" : "低"}`);
        
        if (prediction.recommendations.length > 0) {
          lines.push("");
          lines.push("💡 **推奨アクション:**");
          prediction.recommendations.forEach(rec => lines.push(`・${rec}`));
        }
      }
    } catch (error) {
      console.warn("[goal_progress] prediction failed", error);
      // 予測失敗は詳細表示を止めない
    }
    
    lines.push("");
    lines.push("未着手タスク:");
    
    if (todoTasks.length > 0) {
      todoTasks.slice(0, 5).forEach((task, i) => {
        const priority = task.priority || "-";
        const due = task.dueDate ? ` (期限:${task.dueDate})` : "";
        lines.push(`${i + 1}. [${priority}] ${task.description}${due}`);
      });
      if (todoTasks.length > 5) {
        lines.push(`...他${todoTasks.length - 5}件`);
      }
    } else {
      lines.push("（なし）");
    }
    
    await reply(replyToken, lines.join("\n"), userId);
    return NextResponse.json({ ok: true, mode: "goal_progress_detail", goalId: goal.id });
  }
  
  // 全ゴールの進捗表示
  const goalProgress = await listActiveGoalProgress(storage.goals, storage.tasks);
  
  const lines = ["【ゴール進捗】"];
  
  if (goalProgress.length === 0) {
    lines.push("（アクティブなゴールはない）");
  } else {
    for (const gp of goalProgress) {
      const bar = "█".repeat(Math.floor(gp.progressPercent / 10)) + "░".repeat(10 - Math.floor(gp.progressPercent / 10));
      lines.push(`${gp.goal.title}: ${bar} ${gp.progressPercent}% (${gp.completedTasks}/${gp.totalTasks})`);
    }
  }
  
  lines.push(
    "",
    "詳細を見る: #ゴール進捗 <名前>"
  );
  
  await reply(replyToken, lines.join("\n"), userId);
  return NextResponse.json({ ok: true, mode: "goal_progress_all" });
}

async function handleGoalCompleteCommand(userId: string, replyToken: string, goalTitle: string) {
  const trimmed = goalTitle.trim();
  if (!trimmed) {
    await reply(replyToken, "ゴール名を指定しろ。例: #ゴール完了 キャリアアップ", userId);
    return NextResponse.json({ ok: true, note: "missing_goal_title" });
  }
  
  const goals = await storage.goals.list();
  const goal = goals.find(g => 
    g.title.toLowerCase() === trimmed.toLowerCase() && g.status !== "archived"
  );
  
  if (!goal) {
    await reply(
      replyToken,
      [
        `ゴール「${trimmed}」は見つからない。`,
        "",
        "アクティブなゴール一覧を見るなら:",
        "#ゴール一覧"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, note: "goal_not_found" });
  }
  
  // ゴールをarchivedに変更
  await storage.goals.updateStatus(goal.id, "archived");
  
  // 紐づくタスクの統計
  const tasks = await storage.tasks.listByGoalId(goal.id);
  const doneCount = tasks.filter(t => t.status.toLowerCase() === "done").length;
  const totalCount = tasks.length;
  const completionRate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  
  await reply(
    replyToken,
    [
      `🎉 ゴール「${goal.title}」を完了した！`,
      "",
      `タスク完了率: ${completionRate}% (${doneCount}/${totalCount})`,
      "",
      "お疲れ様。次のゴールに進もう。"
    ].join("\n"),
    userId
  );
  
  return NextResponse.json({ ok: true, mode: "goal_completed", goalId: goal.id });
}

async function handleGoalListCommand(userId: string, replyToken: string) {
  const goals = await storage.goals.list();
  const activeGoals = goals.filter(g => g.status !== "archived");
  const archivedGoals = goals.filter(g => g.status === "archived");
  
  if (activeGoals.length === 0 && archivedGoals.length === 0) {
    await reply(
      replyToken,
      [
        "ゴールはまだない。",
        "",
        "思考ログでゴールを語れば、AIが自動で作成する。",
        "#整理開始 → 目標を語る → #整理終了 → #タスク整理"
      ].join("\n"),
      userId
    );
    return NextResponse.json({ ok: true, note: "no_goals" });
  }
  
  const lines = ["【ゴール一覧】"];
  
  // アクティブなゴール
  if (activeGoals.length > 0) {
    lines.push("", "📍 アクティブ:");
    for (const goal of activeGoals) {
      const tasks = await storage.tasks.listByGoalId(goal.id);
      const doneCount = tasks.filter(t => t.status.toLowerCase() === "done").length;
      const totalCount = tasks.length;
      const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
      const bar = "█".repeat(Math.floor(progressPercent / 10)) + "░".repeat(10 - Math.floor(progressPercent / 10));
      lines.push(`・${goal.title}: ${bar} ${progressPercent}% (${doneCount}/${totalCount})`);
    }
  }
  
  // アーカイブされたゴール
  if (archivedGoals.length > 0) {
    lines.push("", "✅ 完了:");
    for (const goal of archivedGoals.slice(0, 5)) {
      const tasks = await storage.tasks.listByGoalId(goal.id);
      const doneCount = tasks.filter(t => t.status.toLowerCase() === "done").length;
      const totalCount = tasks.length;
      lines.push(`・${goal.title} (${doneCount}/${totalCount})`);
    }
    if (archivedGoals.length > 5) {
      lines.push(`  ...他${archivedGoals.length - 5}件`);
    }
  }
  
  lines.push(
    "",
    "ゴール完了: #ゴール完了 <名前>"
  );
  
  await reply(replyToken, lines.join("\n"), userId);
  return NextResponse.json({ ok: true, mode: "goal_list" });
}

async function handleResetCommand(userId: string, replyToken: string) {
  const active = await sessionRepository.getActiveSession(userId);
  if (!active) {
    await reply(replyToken, "アクティブなセッションはない。問題なし。", userId);
    return NextResponse.json({ ok: true, note: "no_active_session" });
  }
  
  const mode = sessionMode(active);
  const modeLabel = mode === "daily" ? "日報" : "思考ログ";
  
  // セッションを強制終了
  await sessionRepository.end(active.sessionId, userId, "force_reset");
  
  await reply(
    replyToken,
    [
      `🔄 セッションをリセットした。`,
      "",
      `強制終了したモード: ${modeLabel}`,
      `セッションID: ${active.sessionId}`,
      "",
      "新しくモードを開始できる。"
    ].join("\n"),
    userId
  );
  
  return NextResponse.json({ ok: true, mode: "session_reset", sessionId: active.sessionId });
}

async function handleStatusCommand(userId: string, replyToken: string) {
  const active = await sessionRepository.getActiveSession(userId);
  const settings = await storage.userSettings.getOrDefault(userId);
  const todos = await storage.tasks.listTodos();
  const goals = await storage.goals.list();
  
  const lines = ["【現在の状態】"];
  
  // セッション状態
  if (active) {
    const mode = sessionMode(active);
    const modeLabel = mode === "daily" ? "日報モード" : "思考ログモード";
    const messageCount = active.events.filter(e => e.type === "user").length;
    lines.push(
      `📍 アクティブ: ${modeLabel}`,
      `  セッションID: ${active.sessionId}`,
      `  メッセージ数: ${messageCount}件`,
      `  終了方法: ${mode === "daily" ? DAILY_END_KEYWORD : LOG_END_KEYWORD}`
    );
  } else {
    lines.push("📍 アクティブなセッションなし");
  }
  
  // パーソナライズ設定
  const roleNames: Record<CharacterRole, string> = {
    default: "デフォルト",
    ceo: "社長",
    heir: "御曹司",
    athlete: "アスリート",
    scholar: "研究者"
  };
  const toneNames: Record<MessageTone, string> = {
    strict: "厳格",
    formal: "敬語",
    friendly: "フレンドリー"
  };
  lines.push(
    "",
    "⚙️ パーソナライズ:",
    `  キャラクター: ${roleNames[settings.characterRole]}`,
    `  トーン: ${toneNames[settings.messageTone]}`
  );
  
  // タスク・ゴール
  lines.push(
    "",
    "📊 タスク・ゴール:",
    `  未着手タスク: ${todos.length}件`,
    `  アクティブゴール: ${goals.filter(g => g.status !== "archived").length}件`
  );
  
  // 復旧コマンド
  if (active) {
    lines.push(
      "",
      "🔄 セッションをリセットするなら:",
      "#リセット"
    );
  }
  
  await reply(replyToken, lines.join("\n"), userId);
  return NextResponse.json({ ok: true, mode: "status_display" });
}

async function handleSettingsCommand(userId: string, replyToken: string, args: string) {
  const trimmed = args.trim();
  if (!trimmed) {
    // 現在の設定を表示
    const settings = await storage.userSettings.getOrDefault(userId);
    const roleNames: Record<CharacterRole, string> = {
      default: "デフォルト（鬼コーチ）",
      ceo: "社長",
      heir: "御曹司",
      athlete: "アスリート",
      scholar: "研究者"
    };
    const toneNames: Record<MessageTone, string> = {
      strict: "厳格（〜しろ）",
      formal: "敬語（〜してください）",
      friendly: "フレンドリー（〜しよう）"
    };
    
    await replyText(
      replyToken,
      [
        "【現在の設定】",
        `キャラクター: ${roleNames[settings.characterRole]}`,
        `トーン: ${toneNames[settings.messageTone]}`,
        `表示名: ${settings.displayName || "（未設定）"}`,
        "",
        "【変更方法】",
        "#設定 キャラクター 社長",
        "#設定 トーン 敬語",
        "#設定 名前 田中",
        "",
        "【キャラクター一覧】",
        "デフォルト, 社長, 御曹司, アスリート, 研究者",
        "",
        "【トーン一覧】",
        "厳格, 敬語, フレンドリー"
      ].join("\n")
    );
    return NextResponse.json({ ok: true, mode: "settings_show" });
  }
  
  // 設定の変更
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    await replyText(
      replyToken,
      "設定の形式が間違っている。\n\n例: #設定 キャラクター 社長\n例: #設定 トーン 敬語"
    );
    return NextResponse.json({ ok: true, note: "invalid_settings_format" });
  }
  
  const [category, value] = parts;
  const categoryLower = category.toLowerCase();
  const settings = await storage.userSettings.getOrDefault(userId);
  let updated = false;
  let message = "";
  
  if (categoryLower === "キャラクター" || categoryLower === "character" || categoryLower === "role") {
    const roleMap: Record<string, CharacterRole> = {
      デフォルト: "default",
      default: "default",
      社長: "ceo",
      ceo: "ceo",
      御曹司: "heir",
      heir: "heir",
      アスリート: "athlete",
      athlete: "athlete",
      研究者: "scholar",
      scholar: "scholar"
    };
    const role = roleMap[value];
    if (role) {
      settings.characterRole = role;
      settings.updatedAt = new Date().toISOString();
      await storage.userSettings.upsert(settings);
      updated = true;
      message = `キャラクターを「${value}」に変更した。次のメッセージから反映される。`;
    } else {
      message = `「${value}」は無効なキャラクターだ。\n\n有効な値: デフォルト, 社長, 御曹司, アスリート, 研究者`;
    }
  } else if (categoryLower === "トーン" || categoryLower === "tone") {
    const toneMap: Record<string, MessageTone> = {
      厳格: "strict",
      strict: "strict",
      敬語: "formal",
      formal: "formal",
      フレンドリー: "friendly",
      friendly: "friendly"
    };
    const tone = toneMap[value];
    if (tone) {
      settings.messageTone = tone;
      settings.updatedAt = new Date().toISOString();
      await storage.userSettings.upsert(settings);
      updated = true;
      message = `トーンを「${value}」に変更した。次のメッセージから反映される。`;
    } else {
      message = `「${value}」は無効なトーンだ。\n\n有効な値: 厳格, 敬語, フレンドリー`;
    }
  } else if (categoryLower === "名前" || categoryLower === "name" || categoryLower === "displayname") {
    settings.displayName = value;
    settings.updatedAt = new Date().toISOString();
    await storage.userSettings.upsert(settings);
    updated = true;
    message = `表示名を「${value}」に変更した。次のメッセージから反映される。`;
  } else {
    message = `「${category}」は無効な設定項目だ。\n\n有効な項目: キャラクター, トーン, 名前`;
  }
  
  await replyText(replyToken, message);
  return NextResponse.json({ ok: true, mode: updated ? "settings_updated" : "settings_invalid" });
}

async function processTextEvent(event: LineEvent) {
  const replyToken = event.replyToken;
  const userId = event.source?.userId || "";

  if (!replyToken) {
    return NextResponse.json({ ok: true, note: "missing_reply_token" });
  }

  const userText = (event.message?.text || "").trim();
  if (!userText) {
    await replyText(
      replyToken,
      "空のメッセージは処理できない。考えていることを文章で送れ。"
    );
    return NextResponse.json({ ok: true, note: "empty_text" });
  }

  if (HELP_COMMANDS.has(userText.toLowerCase())) {
    await replyText(replyToken, buildCommandReply());
    return NextResponse.json({ ok: true, mode: "help" });
  }

  if (userText.startsWith("/")) {
    await replyText(replyToken, buildCommandReply());
    return NextResponse.json({ ok: true, mode: "command" });
  }

  // キーワードレス化: 「終了」でも終了できる
  if (userText === LOG_START_KEYWORD || userText === LEGACY_LOG_START_KEYWORD || userText === "1") {
    return handleSessionStart(userId, replyToken);
  }

  if (userText === LOG_END_KEYWORD || userText === LEGACY_LOG_END_KEYWORD || userText === "終了") {
    return handleSessionEnd(userId, replyToken);
  }

  if (userText.startsWith(TASK_SUMMARY_COMMAND) || userText === "3") {
    return handleTaskSummaryCommand(userId, replyToken, userText);
  }

  if (
    userText === DAILY_START_KEYWORD ||
    userText.startsWith(`${DAILY_START_KEYWORD} `) ||
    userText.startsWith(`${DAILY_START_KEYWORD}\u3000`) ||
    userText === "2"
  ) {
    return handleDailyStart(userId, replyToken, userText);
  }

  if (userText === DAILY_END_KEYWORD || userText === "終了") {
    return handleDailyEnd(userId, replyToken);
  }

  if (userText.startsWith(DAILY_RESCHEDULE_COMMAND)) {
    return handleDailyRescheduleCommand(userId, replyToken, userText);
  }

  // タスクステータス確認コマンド
  const statusMatch = userText.match(STATUS_CHECK_PATTERN);
  if (statusMatch) {
    const taskId = (statusMatch[2] || "").trim();
    if (!taskId) {
      await replyText(replyToken, "タスクIDを指定しろ。例: status t_1766122744120_1");
      return NextResponse.json({ ok: true, note: "missing_task_id" });
    }
    const task = await storage.tasks.findById(taskId);
    if (!task) {
      await replyText(replyToken, `タスクID「${taskId}」は見つからない。list で一覧を確認しろ。`);
      return NextResponse.json({ ok: true, note: "task_not_found" });
    }
    const lines = [
      "【タスク情報】",
      `ID: ${task.id}`,
      `ステータス: ${task.status}`,
      `説明: ${task.description}`,
      `優先度: ${task.priority || "-"}`,
      `期限: ${task.dueDate || "-"}`,
      `割当日時: ${task.assignedAt || "-"}`,
      `ソースログ: ${task.sourceLogId || "-"}`
    ];
    
    // ゴール情報も表示
    if (task.goalId) {
      const goal = await storage.goals.findById(task.goalId);
      if (goal) {
        lines.push(`ゴール: ${goal.title}`);
      }
    }
    
    await replyText(replyToken, lines.join("\n"));
    return NextResponse.json({ ok: true, mode: "status_check", taskId, status: task.status });
  }

  // タスク分割コマンド
  const splitMatch = userText.match(SPLIT_TASK_PATTERN);
  if (splitMatch) {
    return handleTaskSplit(userId, replyToken, splitMatch[2] || "");
  }

  // タスク再挑戦コマンド
  const retryMatch = userText.match(RETRY_TASK_PATTERN);
  if (retryMatch) {
    return handleTaskRetry(userId, replyToken, retryMatch[2] || "");
  }

  // 設定コマンド
  const settingsMatch = userText.match(SETTINGS_PATTERN);
  if (settingsMatch) {
    return handleSettingsCommand(userId, replyToken, settingsMatch[2] || "");
  }

  // リセットコマンド
  if (RESET_COMMANDS.has(userText.toLowerCase())) {
    return handleResetCommand(userId, replyToken);
  }

  // 状態確認コマンド
  if (STATUS_COMMANDS.has(userText.toLowerCase())) {
    return handleStatusCommand(userId, replyToken);
  }

  // ゴール完了コマンド
  const goalCompleteMatch = userText.match(GOAL_COMPLETE_PATTERN);
  if (goalCompleteMatch) {
    return handleGoalCompleteCommand(userId, replyToken, goalCompleteMatch[2] || "");
  }

  // ゴール一覧コマンド
  if (GOAL_LIST_COMMANDS.has(userText.toLowerCase())) {
    return handleGoalListCommand(userId, replyToken);
  }

  // ゴール進捗コマンド
  const goalProgressMatch = userText.match(GOAL_PROGRESS_PATTERN);
  if (goalProgressMatch) {
    return handleGoalProgressCommand(userId, replyToken, goalProgressMatch[2]);
  }

  const active = await sessionRepository.getActiveSession(userId);
  if (!active) {
    // 朝のタスク選択中かチェック
    const selectedTask = await tryHandleMorningTaskSelection(userId, replyToken, userText);
    if (selectedTask) {
      return selectedTask;
    }
    
    // 「変更」コマンドのチェック
    if (/^(変更|change|タスク変更)$/i.test(userText.trim())) {
      return handleMorningTaskChange(userId, replyToken, userText);
    }
    
    // 条件付き変更（「スマホのみ」「軽いタスク」など）
    if (/スマホ|携帯|軽い|短時間|休む|スキップ/i.test(userText)) {
      return handleMorningTaskChange(userId, replyToken, userText);
    }
    
    const handled = await tryHandleQuickNightReport(userId, replyToken, userText);
    if (handled) {
      return NextResponse.json({ ok: true, mode: "quick_night_report" });
    }
  }
  if (active && isDailySession(active)) {
    return handleDailyMessage(userId, replyToken, userText, active);
  }

  return handleSessionMessage(userId, replyToken, userText);
}

export async function POST(req: Request) {
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const auth = authorizeLineWebhook(rawBody, req.headers.get("x-line-signature"));
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: LineWebhookBody | null = null;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch (error) {
    return NextResponse.json({ ok: true });
  }

  const event = body?.events?.[0];
  if (!isTextMessageEvent(event)) {
    return NextResponse.json({ ok: true });
  }

  try {
    return await processTextEvent(event);
  } catch (error: any) {
    console.error("line webhook error", error);
    if (event.replyToken) {
      try {
        await replyText(
          event.replyToken,
          "整理に失敗した。DeepSeekかストレージかどこかでコケた。あとでログを見る。"
        );
      } catch (replyError) {
        console.error("fallback reply failed", replyError);
      }
    }
    return NextResponse.json({ ok: false, error: error?.message || "failed" });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
