import { NextResponse } from "next/server";
import { createSheetsStorage } from "../../../lib/storage/sheets-repository";

export const runtime = "nodejs";

type CreateGoalBody = {
  title: string;
  confidence?: string;
};

const storage = createSheetsStorage();

function buildGoalId() {
  return `g_${Date.now()}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function GET() {
  const goals = await storage.goals.list();
  return NextResponse.json({ data: goals });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateGoalBody;
    if (!body.title) {
      return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
    }

    const timestamp = nowIso();
    const record = {
      id: buildGoalId(),
      title: body.title,
      confidence: body.confidence ?? "0.8",
      status: "pending" as const,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await storage.goals.add(record);
    return NextResponse.json({ ok: true, data: record }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "failed" },
      { status: 500 }
    );
  }
}
