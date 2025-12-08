import { NextResponse } from "next/server";
import { buildNightMessage } from "../../../../lib/prompts";
import { pushText } from "../../../../lib/adapters/line";

export const runtime = "nodejs";

async function sendNightCheck() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const message = buildNightMessage();
  await pushText(userId, message);
}

async function respond() {
  try {
    await sendNightCheck();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("night job failed", error);
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
