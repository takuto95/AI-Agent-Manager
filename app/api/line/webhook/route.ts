import { NextResponse } from "next/server";
import { GoalIntakeService } from "../../../../lib/core/goal-intake-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { replyText } from "../../../../lib/adapters/line";
import { callDeepSeek } from "../../../../lib/adapters/deepseek";
import {
  DialogueTurn,
  SYSTEM_PROMPT,
  buildSessionDialoguePrompt
} from "../../../../lib/prompts";
import {
  SessionEvent,
  SessionRepository
} from "../../../../lib/storage/session-repository";

export const runtime = "nodejs";

const COMMAND_REPLY =
  "コマンドはまだちゃんと実装していない。\n普通の文章で考えていることを送れ。";
const SESSION_START_KEYWORD =
  process.env.SESSION_START_KEYWORD?.trim() || "#整理開始";
const SESSION_END_KEYWORD =
  process.env.SESSION_END_KEYWORD?.trim() || "#整理終了";

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

function toDialogueTurns(events: SessionEvent[]): DialogueTurn[] {
  return events
    .filter(event => event.type === "user" || event.type === "assistant")
    .map(event => ({
      role: event.type === "user" ? "user" : "assistant",
      message: event.content
    }));
}

function buildConversationTranscript(events: SessionEvent[]) {
  return events
    .filter(event => event.type === "user")
    .map(event => `${event.timestamp || ""} ユーザー: ${event.content}`)
    .join("\n---\n");
}

async function handleSessionStart(userId: string, replyToken: string) {
  const existing = await sessionRepository.getActiveSession(userId);
  if (existing) {
    await replyText(
      replyToken,
      "まだ整理の最中だ。終わらせるなら「" +
        SESSION_END_KEYWORD +
        "」と送れ。"
    );
    return NextResponse.json({ ok: true, mode: "session_already_active" });
  }

  await sessionRepository.start(userId);
  await replyText(
    replyToken,
    [
      "整理モードを開始した。",
      "今の状況・感情・やりたいことを具体的に送れ。",
      `終えたくなったら「${SESSION_END_KEYWORD}」と送信しろ。`
    ].join("\n")
  );

  return NextResponse.json({ ok: true, mode: "session_start" });
}

async function handleSessionEnd(userId: string, replyToken: string) {
  const session = await sessionRepository.getActiveSession(userId);
  if (!session) {
    await replyText(
      replyToken,
      `まだ整理は始まっていない。「${SESSION_START_KEYWORD}」を先に送れ。`
    );
    return NextResponse.json({ ok: true, note: "session_not_found" });
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

  const result = await goalIntakeService.handle({ userId, text: transcript });
  const reply = goalIntakeService.buildReplyMessage(result);
  await sessionRepository.end(session.sessionId, userId, result.logId);
  await replyText(replyToken, reply);

  return NextResponse.json({ ok: true, mode: "session_end", logId: result.logId });
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
      `まず「${SESSION_START_KEYWORD}」を送って整理モードに入れ。`
    );
    return NextResponse.json({ ok: true, note: "session_inactive" });
  }

  await sessionRepository.appendUserMessage(session.sessionId, userId, userText);

  const prompt = buildSessionDialoguePrompt(
    toDialogueTurns(session.events),
    userText
  );

  const aiReply =
    (await callDeepSeek(SYSTEM_PROMPT, prompt)) ||
    "情報が薄い。事実・感情・期限を具体的に書け。";

  await sessionRepository.appendAssistantMessage(
    session.sessionId,
    userId,
    aiReply
  );

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

  if (userText === SESSION_START_KEYWORD) {
    return handleSessionStart(userId, replyToken);
  }

  if (userText === SESSION_END_KEYWORD) {
    return handleSessionEnd(userId, replyToken);
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
