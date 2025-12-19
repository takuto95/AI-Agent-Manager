import { NextResponse } from "next/server";
import { TaskPlannerService } from "../../../../lib/core/task-planner-service";
import { buildMorningMessageV2 } from "../../../../lib/prompts";
import { pushText } from "../../../../lib/adapters/line";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { SessionRepository } from "../../../../lib/storage/session-repository";

export const runtime = "nodejs";

const storage = createSheetsStorage();
const planner = new TaskPlannerService(storage.tasks);
const sessions = new SessionRepository();

async function sendMorningOrder() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const next = await storage.tasks.findNextTodo();
  const todayTask = next?.description?.trim() || (await planner.getTodayTaskDescription());

  // Keep a durable pointer so the user can reply "完了/未達" without entering daily mode.
  await sessions.recordMorningOrder(userId, next?.id ?? "");

  const message = buildMorningMessageV2({ todayTask, taskId: next?.id ?? null });
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
