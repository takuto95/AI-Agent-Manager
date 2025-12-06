import { NextResponse } from "next/server";
import { getSheetValues } from "../../../lib/sheets";
import { pushText } from "../../../lib/line";
import { buildMorningMessage } from "../../../lib/prompts";

export const runtime = "nodejs";

const FALLBACK_TASK = "今日は何もしない。最低でもログを残せ。";

function pickTodoTask(rows: string[][]) {
  return rows.find(row => (row[3] || "").toLowerCase() === "todo");
}

async function sendMorningOrder() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const values = await getSheetValues("tasks");
  const rows = values.length > 1 ? values.slice(1) : [];
  const todo = pickTodoTask(rows);
  const todayTask = todo?.[2]?.trim() || FALLBACK_TASK;

  const message = buildMorningMessage(todayTask);
  await pushText(userId, message);
}

async function respond() {
  try {
    await sendMorningOrder();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("morning cron failed", error);
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
