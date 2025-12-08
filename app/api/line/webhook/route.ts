import { NextResponse } from "next/server";
import { GoalIntakeService } from "../../../../lib/core/goal-intake-service";
import { createSheetsStorage } from "../../../../lib/storage/sheets-repository";
import { replyText } from "../../../../lib/adapters/line";

export const runtime = "nodejs";

const COMMAND_REPLY =
  "コマンドはまだちゃんと実装していない。\n普通の文章で考えていることを送れ。";

type LineMessage = {
  type?: string;
  text?: string;
};

type LineEvent = {
  type?: string;
  replyToken?: string;
  message?: LineMessage;
  source?: { userId?: string };
};

type LineWebhookBody = {
  events?: LineEvent[];
};

const storage = createSheetsStorage();
const goalIntakeService = new GoalIntakeService({
  logsRepo: storage.logs,
  tasksRepo: storage.tasks
});

function isTextMessageEvent(event: LineEvent | undefined): event is LineEvent & {
  message: LineMessage & { type: "text" };
} {
  return !!event && event.type === "message" && event.message?.type === "text";
}

async function processTextEvent(event: LineEvent) {
  const replyToken = event.replyToken;
  const userId = event.source?.userId || "";

  if (!replyToken) {
    return NextResponse.json({ ok: true, note: "missing_reply_token" });
  }

  const userText = (event.message?.text || "").trim();
  if (!userText) {
    await replyText(
      replyToken,
      "空のメッセージは処理できない。考えていることを文章で送れ。"
    );
    return NextResponse.json({ ok: true, note: "empty_text" });
  }

  if (userText.startsWith("/")) {
    await replyText(replyToken, COMMAND_REPLY);
    return NextResponse.json({ ok: true, mode: "command" });
  }

  const result = await goalIntakeService.handle({ userId, text: userText });
  const reply = goalIntakeService.buildReplyMessage(result);
  await replyText(replyToken, reply);

  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  let body: LineWebhookBody | null = null;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json({ ok: true });
  }

  const event = body?.events?.[0];
  if (!isTextMessageEvent(event)) {
    return NextResponse.json({ ok: true });
  }

  try {
    return await processTextEvent(event);
  } catch (error: any) {
    console.error("line webhook error", error);
    if (event.replyToken) {
      try {
        await replyText(
          event.replyToken,
          "整理に失敗した。DeepSeekかストレージかどこかでコケた。あとでログを見る。"
        );
      } catch (replyError) {
        console.error("fallback reply failed", replyError);
      }
    }
    return NextResponse.json({ ok: false, error: error?.message || "failed" });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
