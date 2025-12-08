import { NextResponse } from "next/server";
import { TaskPlannerService } from "../../../../lib/core/task-planner-service";
import { buildMorningMessage } from "../../../../lib/prompts";
import { pushText } from "../../../../lib/adapters/line";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";

export const runtime = "nodejs";

const storage = createSheetsStorage();
const planner = new TaskPlannerService(storage.tasks);

async function sendMorningOrder() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const todayTask = await planner.getTodayTaskDescription();
  const message = buildMorningMessage(todayTask);
  await pushText(userId, message);
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
