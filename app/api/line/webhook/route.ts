import { NextResponse } from "next/server";
import { GoalIntakeService } from "../../../../lib/core/goal-intake-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { TaskRecord } from "../../../../lib/storage/repositories";
import { replyText, replyTextWithQuickReply } from "../../../../lib/adapters/line";
import { callDeepSeek } from "../../../../lib/adapters/deepseek";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_THOUGHT, buildDailyReviewPrompt, buildThoughtAnalysisPrompt } from "../../../../lib/prompts";
import { authorizeLineWebhook } from "../../../../lib/security/line-signature";
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

function buildCommandReply() {
  return `未対応コマンドだ。「${LOG_START_KEYWORD}」/「${LOG_END_KEYWORD}」/「${TASK_SUMMARY_COMMAND}」/「${DAILY_START_KEYWORD}」/「${DAILY_END_KEYWORD}」/「${DAILY_RESCHEDULE_COMMAND}」だけ使え。`;
}

function buildInactiveMenuMessage() {
  return "いまはモード未選択だ。何をしたい？";
}

function buildInactiveMenuButtons() {
  return [
    { label: "思考ログ開始", text: LOG_START_KEYWORD },
    { label: "日報開始", text: DAILY_START_KEYWORD },
    { label: "タスク整理", text: TASK_SUMMARY_COMMAND },
    { label: "ヘルプ", text: "#ヘルプ" }
  ] as const;
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
  tasksRepo: storage.tasks
});
const sessionRepository = new SessionRepository();

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

function buildThoughtReplyMessage(parsed: ThoughtAnalysis | null, aiRaw: string) {
  if (!parsed) {
    return compactReplyLines([
      "整理しようとしたが、AIの出力が正しくなかった。",
      "もう一度だけ気になることを送ってくれると助かる。",
      "",
      aiRaw || "(AI出力が空でした)"
    ]);
  }

  const lines = ["整理してみた。"];
  if (parsed.emotion) {
    lines.push(`感情: ${parsed.emotion}`);
  }
  if (parsed.coreIssue) {
    lines.push(`テーマ: ${parsed.coreIssue}`);
  }
  if (lines[lines.length - 1] !== "") {
    lines.push("");
  }

  if (parsed.aiSummary) {
    lines.push("いまの状況まとめ:");
    lines.push(parsed.aiSummary);
    lines.push("");
  }

  if (parsed.aiSuggestion) {
    lines.push("AIからの提案・材料:");
    lines.push(parsed.aiSuggestion);
    lines.push("");
  }

  const nextStep =
    parsed.userNextStep ||
    "この材料をざっと眺めて、いまの自分を◯ / △ / ×のどれかで返してみて。";
  lines.push("次に、あなたにだけお願いしたい一歩:");
  lines.push(nextStep);

  return compactReplyLines(lines);
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

function buildDailyTaskLine(task: TaskRecord, index: number) {
  const priority = (task.priority || "").trim() || "-";
  const description = (task.description || "").trim() || "（説明なし）";
  const metaParts = [`id:${task.id}`];
  if (task.dueDate) metaParts.push(`期限:${task.dueDate}`);
  const meta = metaParts.join(" / ");
  return `${index + 1}) [${priority}] ${description}\n   ${meta}`;
}

function buildDailyTaskListMessage(tasks: TaskRecord[], title = "未着手タスク一覧", allTodos?: TaskRecord[]) {
  if (!tasks.length) {
    return "【未着手タスク】\n（todoは0件）\n今日はメモだけ残してもいい。";
  }
  const header = `【${title}】（${tasks.length}件）`;
  const base = allTodos && allTodos.length ? allTodos : tasks;
  const indexById = new Map(base.map((t, idx) => [t.id, idx]));
  const lines = tasks.map((task, index) =>
    buildDailyTaskLine(task, indexById.get(task.id) ?? index)
  );
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

  if (taskId) {
    await storage.tasks.updateStatus(taskId, parsed.status);
  }

  const lines: string[] = ["【夜報告】", parsed.status === "done" ? "✅完了" : "❌未達"];
  lines.push(`対象:${taskId || "-"}`);
  if (taskDesc) {
    lines.push(`内容:${taskDesc}`);
  }
  if (parsed.status === "miss") {
    lines.push(`理由:${parsed.reason || "-"}`);
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
    warning: ""
  });

  const replyLines: string[] = [];
  if (taskId) {
    replyLines.push(parsed.status === "done" ? "受理: ✅完了。反映した。" : "受理: ❌未達。反映した。");
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
      "思考ログモードを開始した。",
      "今の状況・感情・やりたいことを具体的に送れ。",
      `終えたくなったら「${LOG_END_KEYWORD}」で締めろ。その後「${TASK_SUMMARY_COMMAND}」でタスク化できる。`
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
      "ログを締めた。内容は保存済みだ。",
      `「${TASK_SUMMARY_COMMAND}」と送れば、このログをもとにタスクを生成する。`
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

  const taskListMessage = buildDailyTaskListMessage(
    displayTodos,
    selection ? "日報対象タスク" : "未着手タスク一覧",
    todos
  );
  const response = [
    "【日報】開始",
    selectionNote ? `※${selectionNote}` : null,
    `終了: ${DAILY_END_KEYWORD}`,
    "",
    taskListMessage,
    "",
    "【使い方（そのまま送ってOK）】",
    "1) 完了: done 1（または done <taskId>）",
    "2) 未達: miss 2 理由（理由は任意）",
    "3) 一覧: list / 一覧",
    "4) 対象: 対象 1,3（絞る） / 対象 全部（解除）",
    "※番号は todo全件リスト基準（対象で絞っても番号は同じ）",
    "※上記以外はメモとして記録"
  ]
    .filter(Boolean)
    .join("\n");

  await replyText(replyToken, response);
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

async function handleDailyMessage(
  userId: string,
  replyToken: string,
  userText: string,
  session: SessionTranscript
) {
  const selectionCommand = extractDailyTaskSelectionCommand(userText);
  if (selectionCommand !== null) {
    const applied = await applyDailyTaskSelectionFromText(session, userId, selectionCommand);
    const { todos, selectedIds } = await resolveDisplayedTodoList(session);
    const selectedSet = new Set(selectedIds);
    const display = selectedIds.length ? todos.filter(t => selectedSet.has(t.id)) : todos;
    const title = selectedIds.length ? "日報対象タスク:" : "未着手タスク一覧:";
    const note = applied.cleared
      ? "日報対象を解除した（todo全件）。"
      : applied.selectedTaskIds.length
        ? `日報対象を設定した（${applied.selectedTaskIds.length}件）。`
        : "指定された日報対象が見つからない（todo全件のまま）。";
    const invalidLine = applied.invalid.length ? `無効: ${applied.invalid.join(", ")}` : "";
    await replyText(
      replyToken,
      [note, invalidLine, buildDailyTaskListMessage(display, title.replace(/:$/, ""), todos)]
        .filter(Boolean)
        .join("\n")
    );
    return NextResponse.json({ ok: true, mode: "daily_task_selection" });
  }

  if (/^(list|一覧)$/i.test(userText.trim())) {
    const { todos, displayed, selectedIds } = await resolveDisplayedTodoList(session);
    if (!selectedIds.length) {
      await replyText(replyToken, buildDailyTaskListMessage(todos, "未着手タスク一覧", todos));
      return NextResponse.json({ ok: true, mode: "daily_list" });
    }
    await replyText(
      replyToken,
      [buildDailyTaskListMessage(displayed, "日報対象タスク", todos), "", "解除: 対象 全部 / 番号は全件基準"].join(
        "\n"
      )
    );
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

  const doneMatch = userText.match(/^(done|完了)\s+(\S+)/i);
  const missMatch = userText.match(/^(miss|未達)\s+(\S+)(?:\s+(.+))?/i);
  const noteMatch = userText.match(/^(note|メモ)\s+(.+)/i);

  const resolveTaskId = async (raw: string) => {
    const token = (raw || "").trim();
    if (!token) return null;
    if (!/^\d+$/.test(token)) return token;
    const displayed = await storage.tasks.listTodos();
    const idx = Number(token) - 1;
    const task = displayed[idx];
    return task?.id ?? null;
  };

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

    await storage.tasks.updateStatus(taskId, "done");
    const timestamp = new Date().toISOString();
    await recordDailyUpdate(session, userId, { taskId, status: "done", timestamp });
    const message = `完了登録: ${task.description}`;
    await sessionRepository.appendAssistantMessage(session.sessionId, userId, message);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "assistant",
      content: message,
      timestamp
    });
    await replyText(replyToken, message);
    return NextResponse.json({ ok: true, mode: "daily_done" });
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

    await storage.tasks.updateStatus(taskId, "miss");
    const timestamp = new Date().toISOString();
    await recordDailyUpdate(session, userId, { taskId, status: "miss", note: reason, timestamp });
    const message = `未達登録: ${task.description}${reason ? ` | 理由: ${reason}` : ""}`;
    await sessionRepository.appendAssistantMessage(session.sessionId, userId, message);
    session.events.push({
      sessionId: session.sessionId,
      userId,
      type: "assistant",
      content: message,
      timestamp
    });
    await replyText(replyToken, message);
    return NextResponse.json({ ok: true, mode: "daily_miss" });
  }

  const noteText = noteMatch ? noteMatch[2] : userText;
  const timestamp = new Date().toISOString();
  await recordDailyUpdate(session, userId, { taskId: "メモ", status: "note", note: noteText, timestamp });
  const message = "メモとして記録した。";
  await sessionRepository.appendAssistantMessage(session.sessionId, userId, message);
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "assistant",
    content: message,
    timestamp
  });
  await replyText(
    replyToken,
    [message, "次: done 1 / miss 2 理由 / list"].join("\n")
  );
  return NextResponse.json({ ok: true, mode: "daily_note" });
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
      const remainingMessage = buildDailyTaskListMessage(remainingTodos, "未着手タスク一覧", remainingTodos);
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

  const replyLines: string[] = [summary, "日報を受け取った。"];
  replyLines.push("", `この日報ログID: ${dailyLogId}`);
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

async function handleSessionMessage(
  userId: string,
  replyToken: string,
  userText: string
) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    await replyTextWithQuickReply(replyToken, buildInactiveMenuMessage(), [...buildInactiveMenuButtons()]);
    return NextResponse.json({ ok: true, note: "session_inactive" });
  }

  if (!isLogSession(session)) {
    await replyText(
      replyToken,
      `今は日報モードだ。「${DAILY_END_KEYWORD}」で締めてから改めてログを開始しろ。`
    );
    return NextResponse.json({ ok: true, note: "session_wrong_mode" });
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
  const aiReply = buildThoughtReplyMessage(parsedThought, aiRaw || "");

  await sessionRepository.appendAssistantMessage(
    session.sessionId,
    userId,
    aiReply
  );
  session.events.push({
    sessionId: session.sessionId,
    userId,
    type: "assistant",
    content: aiReply,
    timestamp: new Date().toISOString()
  });

  await replyText(replyToken, aiReply);
  return NextResponse.json({ ok: true, mode: "session_chat" });
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

  if (userText === LOG_START_KEYWORD || userText === LEGACY_LOG_START_KEYWORD) {
    return handleSessionStart(userId, replyToken);
  }

  if (userText === LOG_END_KEYWORD || userText === LEGACY_LOG_END_KEYWORD) {
    return handleSessionEnd(userId, replyToken);
  }

  if (userText.startsWith(TASK_SUMMARY_COMMAND)) {
    return handleTaskSummaryCommand(userId, replyToken, userText);
  }

  if (
    userText === DAILY_START_KEYWORD ||
    userText.startsWith(`${DAILY_START_KEYWORD} `) ||
    userText.startsWith(`${DAILY_START_KEYWORD}\u3000`)
  ) {
    return handleDailyStart(userId, replyToken, userText);
  }

  if (userText === DAILY_END_KEYWORD) {
    return handleDailyEnd(userId, replyToken);
  }

  if (userText.startsWith(DAILY_RESCHEDULE_COMMAND)) {
    return handleDailyRescheduleCommand(userId, replyToken, userText);
  }

  const active = await sessionRepository.getActiveSession(userId);
  if (!active) {
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
