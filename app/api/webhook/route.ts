import { NextResponse } from "next/server";
import { appendRow } from "../../../lib/sheets";
import { callDeepSeek } from "../../../lib/deepseek";
import { replyText } from "../../../lib/line";
import { SYSTEM_PROMPT, buildAnalysisPrompt } from "../../../lib/prompts";

export const runtime = "nodejs";

const CONFIDENCE_DEFAULT = "0.8";

type LineEvent = {
  type: string;
  replyToken?: string;
  message?: { type: string; text?: string };
  source?: { userId?: string };
};

function nowIso() {
  return new Date().toISOString();
}

function buildGoalId() {
  return `g_${Date.now()}`;
}

async function handleApproval(event: LineEvent, text: string) {
  if (!event.replyToken) return;

  const goalText = text.split(":").slice(1).join(":").trim();
  if (!goalText) {
    await replyText(event.replyToken, "承認するゴールを `承認:ゴール内容` の形式で送れ。");
    return;
  }

  const timestamp = nowIso();
  const goalId = buildGoalId();

  await appendRow("goals", [
    goalId,
    goalText,
    CONFIDENCE_DEFAULT,
    "pending",
    timestamp,
    timestamp
  ]);

  await replyText(event.replyToken, `登録完了: ${goalText} (ID: ${goalId})`);
}

async function handleLog(event: LineEvent, text: string) {
  if (!event.replyToken) return;

  await appendRow("logs", [nowIso(), text, "", "", "", ""]);

  let aiOutput = "";
  try {
    aiOutput = await callDeepSeek(SYSTEM_PROMPT, buildAnalysisPrompt(text));
  } catch (error) {
    console.error("DeepSeek request failed", error);
    await replyText(event.replyToken, "解析に失敗した。後でやり直せ。");
    return;
  }

  let parsed: {
    emotion?: string;
    core_issue?: string;
    current_goal?: string;
    today_task?: string;
    warning?: string;
  } | null = null;

  try {
    parsed = JSON.parse(aiOutput);
  } catch (error) {
    console.warn("DeepSeek returned non-JSON", aiOutput);
  }

  if (!parsed) {
    await replyText(event.replyToken, `解析できなかった。AI出力:\n${aiOutput}`);
    return;
  }

  await appendRow("logs", [
    nowIso(),
    text,
    parsed.today_task || "",
    parsed.emotion || "",
    parsed.current_goal || "",
    ""
  ]);

  const summary = [
    `感情: ${parsed.emotion || "不明"}`,
    `本質: ${parsed.core_issue || "未特定"}`,
    `現在のゴール案: ${parsed.current_goal || "未設定"}`,
    `今日の命令: ${parsed.today_task || "未決定"}`,
    parsed.warning ? `警告: ${parsed.warning}` : null
  ]
    .filter(Boolean)
    .join("\n");

  const approvalGuide = parsed.current_goal
    ? `\n\nゴールとして固定するなら「承認:${parsed.current_goal}」と送れ。`
    : "";

  await replyText(event.replyToken, `解析結果:\n${summary}${approvalGuide}`);
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json({ ok: true });
  }

  const event: LineEvent | undefined = body?.events?.[0];
  if (!event) {
    return NextResponse.json({ ok: true });
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = (event.message.text || "").trim();
    if (text.startsWith("承認:")) {
      await handleApproval(event, text);
    } else {
      await handleLog(event, text);
    }
  }

  return NextResponse.json({ ok: true });
}
