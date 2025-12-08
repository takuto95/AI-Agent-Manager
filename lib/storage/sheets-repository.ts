import { appendRow, getSheetValues, updateCell } from "../adapters/sheets";
import {
  GoalRecord,
  GoalsRepository,
  LogRecord,
  LogsRepository,
  StorageContext,
  TaskRecord,
  TasksRepository
} from "./repositories";

const GOALS_SHEET = "goals";
const TASKS_SHEET = "tasks";
const LOGS_SHEET = "logs";

function pick<T>(row: string[], index: number, fallback = ""): T | string {
  return (row[index] ?? fallback) as T;
}

class SheetsGoalsRepository implements GoalsRepository {
  async add(goal: GoalRecord) {
    await appendRow(GOALS_SHEET, [
      goal.id,
      goal.title,
      goal.confidence,
      goal.status,
      goal.createdAt,
      goal.updatedAt
    ]);
  }

  async list() {
    const values = await getSheetValues(GOALS_SHEET);
    return values.slice(1).map(row => ({
      id: pick<string>(row, 0),
      title: pick<string>(row, 1),
      confidence: pick<string>(row, 2),
      status: (pick<string>(row, 3) || "pending") as GoalRecord["status"],
      createdAt: pick<string>(row, 4),
      updatedAt: pick<string>(row, 5)
    }));
  }
}

class SheetsTasksRepository implements TasksRepository {
  async add(task: TaskRecord) {
    await appendRow(TASKS_SHEET, [
      task.id,
      task.goalId,
      task.description,
      task.status,
      task.dueDate,
      task.priority,
      task.assignedAt,
      task.sourceLogId ?? ""
    ]);
  }

  async listTodos() {
    const values = await getSheetValues(TASKS_SHEET);
    return values
      .slice(1)
      .map((row, index) => this.toRecord(row, index + 2))
      .filter(record => record.status.toLowerCase() === "todo");
  }

  async findNextTodo() {
    const todos = await this.listTodos();
    return todos[0] ?? null;
  }

  async findById(taskId: string) {
    const match = await this.findRowById(taskId);
    if (!match) return null;
    return this.toRecord(match.row, match.rowIndex);
  }

  async updateStatus(taskId: string, status: string) {
    const match = await this.findRowById(taskId);
    if (!match) return false;
    await updateCell(TASKS_SHEET, match.rowIndex, 4, status);
    return true;
  }

  private async findRowById(taskId: string) {
    const values = await getSheetValues(TASKS_SHEET);
    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      if ((row[0] || "") === taskId) {
        return { row, rowIndex: i + 1 };
      }
    }
    return null;
  }

  private toRecord(row: string[], rowIndex?: number): TaskRecord {
    return {
      id: pick<string>(row, 0),
      goalId: pick<string>(row, 1),
      description: pick<string>(row, 2),
      status: pick<string>(row, 3),
      dueDate: pick<string>(row, 4),
      priority: pick<string>(row, 5),
      assignedAt: pick<string>(row, 6),
      sourceLogId: pick<string>(row, 7),
      rowIndex
    };
  }
}

class SheetsLogsRepository implements LogsRepository {
  async add(log: LogRecord) {
    await appendRow(LOGS_SHEET, [
      log.id,
      log.timestamp,
      log.userId,
      log.rawText,
      log.emotion,
      log.coreIssue,
      log.currentGoal,
      log.todayTask,
      log.warning
    ]);
  }

  async listRecent(days: number, limit: number) {
    const values = await getSheetValues(LOGS_SHEET);
    const rows = values.slice(1);
    if (!rows.length) return [];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return rows
      .filter(row => {
        const time = Date.parse(row[1] || "");
        return !Number.isNaN(time) && time >= cutoff;
      })
      .slice(-limit)
      .map(row => ({
        id: pick<string>(row, 0),
        timestamp: pick<string>(row, 1),
        userId: pick<string>(row, 2),
        rawText: pick<string>(row, 3),
        emotion: pick<string>(row, 4),
        coreIssue: pick<string>(row, 5),
        currentGoal: pick<string>(row, 6),
        todayTask: pick<string>(row, 7),
        warning: pick<string>(row, 8)
      }));
  }
}

export function createSheetsStorage(): StorageContext {
  return {
    goals: new SheetsGoalsRepository(),
    tasks: new SheetsTasksRepository(),
    logs: new SheetsLogsRepository()
  };
}
