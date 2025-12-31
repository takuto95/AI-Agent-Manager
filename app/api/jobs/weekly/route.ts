import { NextResponse } from "next/server";
import { pushText } from "../../../../lib/adapters/line";
import { ReflectionService } from "../../../../lib/core/reflection-service";
import { GoalPredictionService } from "../../../../lib/core/goal-prediction-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { personalizeMessage } from "../../../../lib/personalization";

export const runtime = "nodejs";

const DAYS_RANGE = 7;
const MAX_ROWS = 30;
const MONTHLY_DAYS_RANGE = 30;
const MONTHLY_MAX_ROWS = 100;
const QUARTERLY_DAYS_RANGE = 90;
const QUARTERLY_MAX_ROWS = 300;

const storage = createSheetsStorage();
const reflectionService = new ReflectionService({ logsRepo: storage.logs, tasksRepo: storage.tasks });
const predictionService = new GoalPredictionService(storage.goals, storage.tasks);

function isEndOfMonth(): boolean {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getMonth() !== today.getMonth();
}

function isEndOfQuarter(): boolean {
  const today = new Date();
  const month = today.getMonth();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  // 四半期末: 3月, 6月, 9月, 12月
  const quarterEndMonths = [2, 5, 8, 11]; // 0-indexed
  return quarterEndMonths.includes(month) && tomorrow.getMonth() !== today.getMonth();
}

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

  // パーソナライズを適用
  const settings = await storage.userSettings.getOrDefault(userId);
  await pushText(userId, personalizeMessage(message, settings));
  
  // ゴール予測・最適化サマリーを追加送信
  try {
    const goalSummary = await predictionService.generateWeeklySummary();
    await pushText(userId, personalizeMessage(goalSummary, settings));
  } catch (error) {
    console.warn("[weekly] goal prediction failed", error);
    // 予測失敗はレビュー全体を止めない
  }
}

async function sendMonthlyReview() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const message = await reflectionService.buildMonthlyMessage(MONTHLY_DAYS_RANGE, MONTHLY_MAX_ROWS);
  if (!message) {
    await pushText(userId, "月次ログが足りない。30日以内の記録を溜めろ。");
    return;
  }

  await pushText(userId, message);
}

async function sendQuarterlyReview() {
  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }

  const message = await reflectionService.buildQuarterlyMessage(QUARTERLY_DAYS_RANGE, QUARTERLY_MAX_ROWS);
  if (!message) {
    await pushText(userId, "四半期ログが足りない。90日以内の記録を溜めろ。");
    return;
  }

  await pushText(userId, message);
}

async function respond() {
  try {
    // 週次レビューは毎回実行
    await sendWeeklyReview();
    
    // 月末判定: 月次レビューを追加実行
    if (isEndOfMonth()) {
      console.log("[monthly-review] Executing monthly review...");
      await sendMonthlyReview();
    }
    
    // 四半期末判定: 四半期レビューを追加実行
    if (isEndOfQuarter()) {
      console.log("[quarterly-review] Executing quarterly review...");
      await sendQuarterlyReview();
    }
    
    return NextResponse.json({ 
      ok: true, 
      weekly: true, 
      monthly: isEndOfMonth(), 
      quarterly: isEndOfQuarter() 
    });
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
