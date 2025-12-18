import { NextResponse } from "next/server";
import { pushText } from "../../../../lib/adapters/line";
import { authorizeInternalRequest } from "../../../../lib/security/internal-auth";

export const runtime = "nodejs";

type PushPayload = {
  userId?: string;
  message: string;
};

export async function POST(req: Request) {
  const auth = authorizeInternalRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
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
