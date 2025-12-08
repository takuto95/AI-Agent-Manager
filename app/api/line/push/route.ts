import { NextResponse } from "next/server";
import { pushText } from "../../../../lib/adapters/line";

export const runtime = "nodejs";

type PushPayload = {
  userId?: string;
  message: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PushPayload;
    const targetUserId = body.userId || process.env.LINE_USER_ID;
    if (!targetUserId) {
      return NextResponse.json(
        { ok: false, error: "LINE_USER_ID is not set" },
        { status: 400 }
      );
    }

    if (!body.message) {
      return NextResponse.json({ ok: false, error: "message is required" }, { status: 400 });
    }

    await pushText(targetUserId, body.message);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "failed" },
      { status: 500 }
    );
  }
}
