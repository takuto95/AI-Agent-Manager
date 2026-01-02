import { NextResponse } from "next/server";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { replyText, replyMessages } from "../../../../lib/adapters/line";
import { authorizeLineWebhook } from "../../../../lib/security/line-signature";
import { SessionRepository } from "../../../../lib/storage/session-repository";
import { buildTaskStartedMessage, buildSnoozeMessage } from "../../../../lib/line/flex-messages";

export const runtime = "nodejs";

const CONFIDENCE_DEFAULT = "0.8";

type LinePostbackEvent = {
  replyToken?: string;
  postback?: { data?: string };
  source?: { userId?: string };
};

const storage = createSheetsStorage();
const sessions = new SessionRepository();

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

async function handleStartTask(event: LinePostbackEvent, data: string) {
  const params = new URLSearchParams(data);
  const taskId = params.get('taskId');
  
  if (!taskId) {
    if (event.replyToken) {
      await replyText(event.replyToken, "タスクIDが見つからない。");
    }
    return;
  }

  const userId = event.source?.userId || process.env.LINE_USER_ID;
  if (!userId) {
    if (event.replyToken) {
      await replyText(event.replyToken, "ユーザーIDが特定できない。");
    }
    return;
  }

  // タスク情報を取得
  const task = await storage.tasks.getById(taskId);
  if (!task) {
    if (event.replyToken) {
      await replyText(event.replyToken, `タスクが見つからない（ID: ${taskId}）`);
    }
    return;
  }

  // sessions に task_started イベントを記録
  const session = await sessions.start(userId, "system");
  await sessions.record({
    sessionId: session.sessionId,
    userId,
    type: "user" as any, // task_started type を追加する場合は session-repository.ts を拡張
    content: `task_started:${taskId}`,
    timestamp: new Date().toISOString(),
    meta: JSON.stringify({ taskId, startedAt: new Date().toISOString() })
  });
  await sessions.end(session.sessionId, userId, "task_started");

  // タスク開始の確認メッセージ + クイックリプライ
  if (event.replyToken) {
    const messages = buildTaskStartedMessage({ taskDescription: task.description });
    await replyMessages(event.replyToken, messages);
  }
}

async function handleSnoozeTask(event: LinePostbackEvent, data: string) {
  const params = new URLSearchParams(data);
  const taskId = params.get('taskId');
  
  if (!taskId) {
    if (event.replyToken) {
      await replyText(event.replyToken, "タスクIDが見つからない。");
    }
    return;
  }

  const userId = event.source?.userId || process.env.LINE_USER_ID;
  if (!userId) {
    if (event.replyToken) {
      await replyText(event.replyToken, "ユーザーIDが特定できない。");
    }
    return;
  }

  // sessions に snooze イベントを記録
  const session = await sessions.start(userId, "system");
  await sessions.record({
    sessionId: session.sessionId,
    userId,
    type: "user" as any,
    content: `task_snoozed:${taskId}`,
    timestamp: new Date().toISOString(),
    meta: JSON.stringify({ 
      taskId, 
      snoozedAt: new Date().toISOString(),
      snoozeMinutes: 60 
    })
  });
  await sessions.end(session.sessionId, userId, "task_snoozed");

  // スヌーズ確認メッセージ + クイックリプライ
  if (event.replyToken) {
    const message = buildSnoozeMessage();
    await replyMessages(event.replyToken, [message]);
  }

  // TODO: 1時間後の再通知機能を実装する場合はここに追加
  // 例: スケジュールジョブに登録、または Vercel Cron で定期チェック
}

export async function POST(req: Request) {
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const auth = authorizeLineWebhook(rawBody, req.headers.get("x-line-signature"));
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const event: LinePostbackEvent | undefined = body?.events?.[0];
  const data = event?.postback?.data || "";

  if (data.startsWith("approve_goal:")) {
    await handleApproveGoal(event ?? {}, data);
  } else if (data.startsWith("action=start_task")) {
    await handleStartTask(event ?? {}, data);
  } else if (data.startsWith("action=snooze_task")) {
    await handleSnoozeTask(event ?? {}, data);
  } else if (data === "action=change_task") {
    // 既存の朝の命令対話化機能（変更フロー）を呼び出す
    // TODO: webhook側の変更フローと統合
    if (event?.replyToken) {
      await replyText(event.replyToken, "タスク変更機能は現在開発中。「変更」とメッセージで送ってください。");
    }
  } else if (event?.replyToken) {
    await replyText(event.replyToken, "未対応のpostbackデータだ。");
  }

  return NextResponse.json({ ok: true });
}
