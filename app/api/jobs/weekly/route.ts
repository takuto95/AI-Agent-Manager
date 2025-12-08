import { NextResponse } from "next/server";
import { pushText } from "../../../../lib/adapters/line";
import { ReflectionService } from "../../../../lib/core/reflection-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";

export const runtime = "nodejs";

const DAYS_RANGE = 7;
const MAX_ROWS = 30;

const storage = createSheetsStorage();
const reflectionService = new ReflectionService({ logsRepo: storage.logs });

async function sendWeeklyReview() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const message = await reflectionService.buildWeeklyMessage(DAYS_RANGE, MAX_ROWS);
  if (!message) {
    await pushText(userId, "週次ログが足りない。7日以内の記録を溜めろ。");
    return;
  }

  await pushText(userId, message);
}

async function respond() {
  try {
    await sendWeeklyReview();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("weekly job failed", error);
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
