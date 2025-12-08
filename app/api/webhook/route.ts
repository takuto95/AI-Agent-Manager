import { NextResponse } from "next/server";
import { appendRow } from "../../../lib/sheets";
import { callDeepSeek } from "../../../lib/deepseek";
import { replyText } from "../../../lib/line";
import { SYSTEM_PROMPT, buildAnalysisPrompt } from "../../../lib/prompts";

export const runtime = "nodejs";

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

const COMMAND_REPLY =
  "コマンドはまだちゃんと実装していない。\n普通の文章で考えていることを送れ。";

function buildLogId() {
  return `l_${Date.now()}`;
}

function buildTaskId() {
  return `t_${Date.now()}`;
}

function tryParseJsonObject(
  text: string
): {
  emotion?: string;
  core_issue?: string;
  current_goal?: string;
  today_task?: string;
  warning?: string;
} | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function isTextMessageEvent(event: LineEvent | undefined): event is LineEvent & {
  message: LineMessage & { type: "text" };
} {
  return !!event && event.type === "message" && event.message?.type === "text";
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

  const timestamp = new Date().toISOString();
  const logId = buildLogId();

  const prompt = buildAnalysisPrompt(userText);
  const aiRaw = await callDeepSeek(SYSTEM_PROMPT, prompt);

  const parsed = tryParseJsonObject(aiRaw);

  if (!parsed) {
    await appendRow("logs", [logId, timestamp, userId, userText, "", "", "", "", ""]);
    await replyText(
      replyToken,
      `整理しようとしたが、AIの出力がJSONじゃなかった。\nそのまま吐く:\n${aiRaw}`
    );
    return NextResponse.json({ ok: false, error: "parse_failed" });
  }

  const emotion = (parsed.emotion || "").trim();
  const coreIssue = (parsed.core_issue || "").trim();
  const currentGoal = (parsed.current_goal || "").trim();
  const todayTask = (parsed.today_task || "").trim();
  const warning = (parsed.warning || "").trim();

  await appendRow("logs", [
    logId,
    timestamp,
    userId,
    userText,
    emotion,
    coreIssue,
    currentGoal,
    todayTask,
    warning
  ]);

  if (todayTask) {
    const taskId = buildTaskId();
    await appendRow("tasks", [
      taskId,
      currentGoal || "",
      todayTask,
      "todo",
      "",
      "A",
      timestamp,
      logId
    ]);
  }

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

  await replyText(replyToken, lines.join("\n"));

  return NextResponse.json({ ok: true });
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
    console.error("webhook error", error);
    if (event.replyToken) {
      try {
        await replyText(
          event.replyToken,
          "整理に失敗した。DeepSeekかSheetsかどこかでコケた。あとでログを見る。"
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
