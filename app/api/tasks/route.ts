import { NextResponse } from "next/server";
import { createSheetsStorage } from "../../../lib/storage/sheets-repository";

export const runtime = "nodejs";

type CreateTaskBody = {
  goalId?: string;
  description: string;
  priority?: string;
};

const storage = createSheetsStorage();

function buildTaskId() {
  return `t_${Date.now()}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function GET() {
  const tasks = await storage.tasks.listTodos();
  return NextResponse.json({ data: tasks });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateTaskBody;
    if (!body.description) {
      return NextResponse.json({ ok: false, error: "description is required" }, { status: 400 });
    }

    const timestamp = nowIso();
    const record = {
      id: buildTaskId(),
      goalId: body.goalId ?? "",
      description: body.description,
      status: "todo",
      dueDate: "",
      priority: body.priority ?? "B",
      assignedAt: timestamp,
      sourceLogId: ""
    };

    await storage.tasks.add(record);
    return NextResponse.json({ ok: true, data: record }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "failed" },
      { status: 500 }
    );
  }
}
