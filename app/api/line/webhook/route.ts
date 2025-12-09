import { NextResponse } from "next/server";
import { GoalIntakeService } from "../../../../lib/core/goal-intake-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { TaskRecord } from "../../../../lib/storage/repositories";
import { replyText } from "../../../../lib/adapters/line";
import { callDeepSeek } from "../../../../lib/adapters/deepseek";
import { SYSTEM_PROMPT_THOUGHT, buildThoughtAnalysisPrompt } from "../../../../lib/prompts";
import {
  SessionEvent,
  SessionMode,
  SessionRepository,
  SessionTranscript
} from "../../../../lib/storage/session-repository";

export const runtime = "nodejs";

const COMMAND_REPLY =
  "未対応コマンドだ。#ログ開始 / #ログ終了 / #タスク整理 / #日報開始 / #日報終了 だけ使え。";
const LOG_START_KEYWORD = process.env.SESSION_START_KEYWORD?.trim() || "#整理開始";
const LOG_END_KEYWORD = process.env.SESSION_END_KEYWORD?.trim() || "#整理終了";
const TASK_SUMMARY_COMMAND = process.env.TASK_SUMMARY_COMMAND?.trim() || "#タスク整理";
const DAILY_START_KEYWORD = process.env.DAILY_START_KEYWORD?.trim() || "#日報開始";
const DAILY_END_KEYWORD = process.env.DAILY_END_KEYWORD?.trim() || "#日報終了";

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
  const due = task.dueDate ? ` (期限:${task.dueDate})` : "";
  return `${index + 1}. ${task.id} [${task.priority}] ${task.description}${due}`;
}

function buildDailyTaskListMessage(tasks: TaskRecord[]) {
  if (!tasks.length) {
    return "未着手のタスクはない。完了報告だけ送れ。";
  }
  const header = "未着手タスク一覧:";
  const lines = tasks.map((task, index) => buildDailyTaskLine(task, index));
  return [header, ...lines].join("\n");
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
      "解析済みのログがない。まず「#ログ開始 → #ログ終了」で思考を流せ。"
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
    [reply, "", `このログID: ${result.logId}`, "日報に移るなら「#日報開始」と送れ。"].join("\n")
  );

  return NextResponse.json({ ok: true, mode: "task_summary", logId: result.logId });
}

async function handleDailyStart(userId: string, replyToken: string) {
  const existing = await sessionRepository.getActiveSession(userId);
  if (existing) {
    await replyText(
      replyToken,
      `別モードが動いている。「${isDailySession(existing) ? DAILY_END_KEYWORD : LOG_END_KEYWORD}」で終わらせろ。`
    );
    return NextResponse.json({ ok: true, note: "session_already_active" });
  }

  const session = await sessionRepository.start(userId, "daily");
  const todos = await storage.tasks.listTodos();
  const taskListMessage = buildDailyTaskListMessage(todos);
  const response = [
    "日報モードを開始した。",
    taskListMessage,
    "",
    "完了: `done <taskId>` / 未達: `miss <taskId> <理由>` / メモ: `note <内容>`",
    `終えるときは「${DAILY_END_KEYWORD}」。`
  ].join("\n");

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

  if (doneMatch) {
    const taskId = doneMatch[2];
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
    const taskId = missMatch[2];
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
    `${message}\n完了なら「done <taskId>」、未達なら「miss <taskId> <理由>」と入力しろ。`
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

  if (updates.length) {
    await storage.logs.add({
      id: buildDailyLogId(),
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

  await replyText(replyToken, `${summary}\n日報を受け取った。`);
  return NextResponse.json({ ok: true, mode: "daily_end" });
}

async function handleSessionMessage(
  userId: string,
  replyToken: string,
  userText: string
) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    await replyText(
      replyToken,
      `まず「${LOG_START_KEYWORD}」を送って思考ログモードに入れ。`
    );
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

  if (userText.startsWith("/")) {
    await replyText(replyToken, COMMAND_REPLY);
    return NextResponse.json({ ok: true, mode: "command" });
  }

  if (userText === LOG_START_KEYWORD) {
    return handleSessionStart(userId, replyToken);
  }

  if (userText === LOG_END_KEYWORD) {
    return handleSessionEnd(userId, replyToken);
  }

  if (userText.startsWith(TASK_SUMMARY_COMMAND)) {
    return handleTaskSummaryCommand(userId, replyToken, userText);
  }

  if (userText === DAILY_START_KEYWORD) {
    return handleDailyStart(userId, replyToken);
  }

  if (userText === DAILY_END_KEYWORD) {
    return handleDailyEnd(userId, replyToken);
  }

  const active = await sessionRepository.getActiveSession(userId);
  if (active && isDailySession(active)) {
    return handleDailyMessage(userId, replyToken, userText, active);
  }

  return handleSessionMessage(userId, replyToken, userText);
}

export async function POST(req: Request) {
  let body: LineWebhookBody | null = null;
  try {
    body = await req.json();
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
