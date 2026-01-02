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

export async function GET(req: Request) {
  try {
    // URLパラメータからuserIdを取得
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId');
    
    // 全タスクを取得
    const allTasks = await storage.tasks.listAll();
    
    // todoタスクのみフィルタ
    const todoTasks = allTasks.filter(t => t.status.toLowerCase() === 'todo');
    
    // 統計情報を計算
    const doneTasks = allTasks.filter(t => t.status.toLowerCase() === 'done');
    const totalTasks = todoTasks.length + doneTasks.length;
    
    // ゴール情報を付加
    const tasksWithGoals = await Promise.all(
      todoTasks.map(async (task) => {
        let goalTitle = '';
        if (task.goalId) {
          try {
            const goal = await storage.goals.getById(task.goalId);
            goalTitle = goal?.title || '';
          } catch (error) {
            console.warn(`Goal not found: ${task.goalId}`);
          }
        }
        return {
          ...task,
          goalTitle
        };
      })
    );
    
    // 優先度順にソート
    const sortedTasks = tasksWithGoals.sort((a, b) => {
      const priorityOrder: { [key: string]: number } = { 'A': 1, 'B': 2, 'C': 3 };
      const aPriority = priorityOrder[a.priority || 'C'] || 999;
      const bPriority = priorityOrder[b.priority || 'C'] || 999;
      
      if (aPriority !== bPriority) return aPriority - bPriority;
      
      // 優先度が同じ場合は期限順
      if (a.dueDate && b.dueDate) {
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      
      return 0;
    });
    
    return NextResponse.json({
      tasks: sortedTasks,
      stats: {
        todo: todoTasks.length,
        done: doneTasks.length,
        total: totalTasks,
        completionRate: totalTasks > 0 ? Math.round((doneTasks.length / totalTasks) * 100) : 0
      }
    });
  } catch (error: any) {
    console.error('GET /api/tasks error:', error);
    return NextResponse.json(
      { ok: false, error: error?.message || "failed to fetch tasks" },
      { status: 500 }
    );
  }
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
