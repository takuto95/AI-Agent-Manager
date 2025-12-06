import { NextResponse } from "next/server";
import { getSheetValues } from "../../../lib/sheets";
import { callDeepSeek } from "../../../lib/deepseek";
import { SYSTEM_PROMPT, buildWeeklyReviewPrompt } from "../../../lib/prompts";
import { pushText } from "../../../lib/line";

export const runtime = "nodejs";

const DAYS_RANGE = 7;
const MAX_ROWS = 30;

function cutoffDate() {
  const date = new Date();
  date.setDate(date.getDate() - DAYS_RANGE);
  return date.getTime();
}

function formatLog(row: string[]) {
  const [timestamp, raw = "", summary = "", emotion = ""] = row;
  return `${timestamp} | raw:${raw} | summary:${summary} | emotion:${emotion}`;
}

function collectWeekLogs(rows: string[][]) {
  const cutoff = cutoffDate();
  return rows
    .filter(row => {
      const time = Date.parse(row[0] || "");
      return !Number.isNaN(time) && time >= cutoff;
    })
    .slice(-MAX_ROWS)
    .map(formatLog)
    .join("\n---\n");
}

async function sendWeeklyReview() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const values = await getSheetValues("logs");
  const rows = values.length > 1 ? values.slice(1) : [];
  const weekLogs = collectWeekLogs(rows);

  if (!weekLogs) {
    await pushText(userId, "週次ログが足りない。7日以内の記録を溜めろ。");
    return;
  }

  let aiOutput = "";
  try {
    aiOutput = await callDeepSeek(SYSTEM_PROMPT, buildWeeklyReviewPrompt(weekLogs));
  } catch (error) {
    console.error("weekly review failed", error);
    await pushText(userId, "週次レビュー生成に失敗した。後で再実行。");
    return;
  }

  let parsed: {
    evaluation?: string;
    excuses_detected?: string[];
    goal_adjusted?: string;
    next_week_task?: string;
  } | null = null;

  try {
    parsed = JSON.parse(aiOutput);
  } catch (error) {
    console.warn("weekly review JSON parse failure", aiOutput);
  }

  if (!parsed) {
    await pushText(userId, `週次レビューを解析できなかった。出力:\n${aiOutput}`);
    return;
  }

  const message = [
    "【週次レビュー】",
    parsed.evaluation ? `評価: ${parsed.evaluation}` : null,
    parsed.excuses_detected?.length
      ? `甘え検出: ${parsed.excuses_detected.join(", ")}`
      : null,
    parsed.goal_adjusted ? `修正ゴール: ${parsed.goal_adjusted}` : null,
    parsed.next_week_task ? `来週の命令: ${parsed.next_week_task}` : null
  ]
    .filter(Boolean)
    .join("\n");

  await pushText(userId, message);
}

async function respond() {
  try {
    await sendWeeklyReview();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("weekly endpoint failed", error);
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
