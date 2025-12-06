import type { NextApiRequest, NextApiResponse } from "next";
import { appendRow } from "../lib/sheets";
import { replyText } from "../lib/line";

const CONFIDENCE_DEFAULT = "0.8";

function nowIso() {
  return new Date().toISOString();
}

function buildGoalId() {
  return `g_${Date.now()}`;
}

async function handleApproveGoal(event: any, payload: string) {
  const goalText = payload.split(":").slice(1).join(":").trim();
  if (!goalText) {
    await replyText(event.replyToken, "postbackデータにゴール内容が含まれていません。");
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

  await replyText(event.replyToken, `ゴールを登録しました (${goalId})`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const event = req.body?.events?.[0];
  if (!event || event.type !== "postback") {
    return res.status(200).json({ ok: true });
  }

  const data: string = event.postback?.data || "";
  if (data.startsWith("approve_goal:")) {
    await handleApproveGoal(event, data);
  }

  return res.status(200).json({ ok: true });
}
