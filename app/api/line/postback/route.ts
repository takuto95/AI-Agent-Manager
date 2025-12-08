import { NextResponse } from "next/server";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { replyText } from "../../../../lib/adapters/line";

export const runtime = "nodejs";

const CONFIDENCE_DEFAULT = "0.8";

type LinePostbackEvent = {
  replyToken?: string;
  postback?: { data?: string };
};

const storage = createSheetsStorage();

function nowIso() {
  return new Date().toISOString();
}

function buildGoalId() {
  return `g_${Date.now()}`;
}

async function handleApproveGoal(event: LinePostbackEvent, data: string) {
  const payload = data.split(":").slice(1).join(":").trim();
  if (!payload) {
    if (event.replyToken) {
      await replyText(event.replyToken, "ゴール内容が空だ。approve_goal:<内容> の形式で送れ。");
    }
    return;
  }

  const goalId = buildGoalId();
  const timestamp = nowIso();
  await storage.goals.add({
    id: goalId,
    title: payload,
    confidence: CONFIDENCE_DEFAULT,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  if (event.replyToken) {
    await replyText(event.replyToken, `承認した。ID: ${goalId}`);
  }
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json({ ok: true });
  }

  const event: LinePostbackEvent | undefined = body?.events?.[0];
  const data = event?.postback?.data || "";

  if (data.startsWith("approve_goal:")) {
    await handleApproveGoal(event ?? {}, data);
  } else if (event?.replyToken) {
    await replyText(event.replyToken, "未対応のpostbackデータだ。approve_goalのみサポート中。");
  }

  return NextResponse.json({ ok: true });
}
