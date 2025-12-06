import type { NextApiRequest, NextApiResponse } from "next";
import { replyText } from "../lib/line";
import { callDeepSeek } from "../lib/deepseek";
import { analysisPrompt, SYSTEM_PROMPT } from "../lib/prompts";
import { appendRow } from "../lib/sheets";

type LineEvent = {
  type: string;
  replyToken: string;
  message?: { type: string; text?: string };
  source?: { userId?: string };
};

const CONFIDENCE_DEFAULT = "0.8";

function nowIso() {
  return new Date().toISOString();
}

function buildGoalId() {
  return `g_${Date.now()}`;
}

async function handleApproval(event: LineEvent, text: string) {
  const goalText = text.split(":").slice(1).join(":").trim();
  if (!goalText) {
    await replyText(event.replyToken, "承認フォーマット: 承認:ゴール内容 を入力してください。");
    return;
  }

  const goalId = buildGoalId();
  const timestamp = nowIso();

  await appendRow("goals", [
    goalId,
    goalText,
    CONFIDENCE_DEFAULT,
    "pending",
    timestamp,
    timestamp
  ]);

  await replyText(event.replyToken, `ゴールを登録しました (${goalId}): ${goalText}`);
}

async function handleLog(event: LineEvent, text: string) {
  await appendRow("logs", [nowIso(), text, "", "", "", ""]);

  let aiRaw = "";
  try {
    aiRaw = await callDeepSeek(SYSTEM_PROMPT, analysisPrompt(text));
  } catch (error) {
    console.error("DeepSeek解析エラー", error);
    await replyText(event.replyToken, "解析に失敗しました。後でもう一度試してください。");
    return;
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(aiRaw);
  } catch (error) {
    console.warn("DeepSeekからJSON以外が返却", aiRaw);
  }

  if (!parsed) {
    await replyText(event.replyToken, `解析に失敗しました。AIの出力:\n${aiRaw}`);
    return;
  }

  await appendRow("logs", [
    nowIso(),
    text,
    parsed.today_task || "",
    parsed.emotion || "",
    parsed.goal_candidate || "",
    parsed.warning || ""
  ]);

  const summary = [
    `感情: ${parsed.emotion || "不明"}`,
    `本質: ${parsed.core_issue || "未特定"}`,
    `提案ゴール: ${parsed.goal_candidate || "なし"}`,
    `今日の一手: ${parsed.today_task || "未定"}`,
    parsed.warning ? `警告: ${parsed.warning}` : null
  ]
    .filter(Boolean)
    .join("\n");

  const approvalGuide = parsed.goal_candidate
    ? "\n\nゴールを採用する場合は「承認:ゴール内容」または「承認:はい」と送信してください。"
    : "";

  await replyText(event.replyToken, `解析結果:\n${summary}${approvalGuide}`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const event: LineEvent | undefined = req.body?.events?.[0];
  if (!event) {
    return res.status(200).json({ ok: true });
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = (event.message.text || "").trim();
    if (text.startsWith("承認:")) {
      await handleApproval(event, text);
    } else {
      await handleLog(event, text);
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}
