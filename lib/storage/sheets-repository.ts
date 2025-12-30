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

type ColumnMap = Map<string, number>; // normalized header -> 1-based column index

type HeaderInfo = { map: ColumnMap; headerLength: number };

const headerInfoCache = new Map<string, HeaderInfo>();

function normalizeHeaderName(value: string) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "");
}

function buildColumnMap(headerRow: string[]): ColumnMap {
  const map: ColumnMap = new Map();
  headerRow.forEach((name, idx) => {
    const normalized = normalizeHeaderName(name);
    if (!normalized) return;
    // first occurrence wins (avoid accidental duplicates overwriting)
    if (!map.has(normalized)) {
      map.set(normalized, idx + 1);
    }
  });
  return map;
}

function resolveColumnIndex(map: ColumnMap, ...aliases: string[]) {
  for (const alias of aliases) {
    const idx = map.get(normalizeHeaderName(alias));
    if (idx) return idx;
  }
  return null;
}

async function getColumnMap(sheetName: string): Promise<ColumnMap | null> {
  const cached = headerInfoCache.get(sheetName);
  if (cached) return cached.map;
  const values = await getSheetValues(sheetName);
  const header = values[0];
  if (!header || !header.length) return null;
  const map = buildColumnMap(header);
  if (!map.size) return null;
  headerInfoCache.set(sheetName, { map, headerLength: header.length });
  return map;
}

async function getHeaderInfo(sheetName: string): Promise<HeaderInfo | null> {
  const cached = headerInfoCache.get(sheetName);
  if (cached) return cached;
  const values = await getSheetValues(sheetName);
  const header = values[0];
  if (!header || !header.length) return null;
  const map = buildColumnMap(header);
  if (!map.size) return null;
  const info = { map, headerLength: header.length };
  headerInfoCache.set(sheetName, info);
  return info;
}

function pickByColumn<T>(row: string[], map: ColumnMap | null, fallbackIndex: number, ...aliases: string[]) {
  const col = map ? resolveColumnIndex(map, ...aliases) : null;
  const idx0 = (col ? col - 1 : fallbackIndex);
  return (row[idx0] ?? "") as T;
}

function setByColumn(row: (string | number | null)[], map: ColumnMap, value: string | number | null, ...aliases: string[]) {
  const col = resolveColumnIndex(map, ...aliases);
  if (!col) return false;
  const idx0 = col - 1;
  while (row.length <= idx0) row.push("");
  row[idx0] = value;
  return true;
}

class SheetsGoalsRepository implements GoalsRepository {
  async add(goal: GoalRecord) {
    const header = await getHeaderInfo(GOALS_SHEET);
    if (!header) {
      await appendRow(GOALS_SHEET, [
        goal.id,
        goal.title,
        goal.confidence,
        goal.status,
        goal.createdAt,
        goal.updatedAt
      ]);
      return;
    }

    const row: (string | number | null)[] = Array.from({ length: header.headerLength }, () => "");
    setByColumn(row, header.map, goal.id, "id");
    setByColumn(row, header.map, goal.title, "title");
    setByColumn(row, header.map, goal.confidence, "confidence");
    setByColumn(row, header.map, goal.status, "status");
    setByColumn(row, header.map, goal.createdAt, "createdAt", "created_at");
    setByColumn(row, header.map, goal.updatedAt, "updatedAt", "updated_at");
    await appendRow(GOALS_SHEET, row);
  }

  async list() {
    const values = await getSheetValues(GOALS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    return values.slice(1).map(row => ({
      id: pickByColumn<string>(row, map, 0, "id"),
      title: pickByColumn<string>(row, map, 1, "title"),
      confidence: pickByColumn<string>(row, map, 2, "confidence"),
      status: ((pickByColumn<string>(row, map, 3, "status") || "pending") as GoalRecord["status"]),
      createdAt: pickByColumn<string>(row, map, 4, "createdAt", "created_at"),
      updatedAt: pickByColumn<string>(row, map, 5, "updatedAt", "updated_at")
    }));
  }

  async findById(goalId: string) {
    const values = await getSheetValues(GOALS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    const idCol0 = map ? (resolveColumnIndex(map, "id") ?? 1) - 1 : 0;
    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      if (((row[idCol0] || "") as string) === goalId) {
        return {
          id: pickByColumn<string>(row, map, 0, "id"),
          title: pickByColumn<string>(row, map, 1, "title"),
          confidence: pickByColumn<string>(row, map, 2, "confidence"),
          status: ((pickByColumn<string>(row, map, 3, "status") || "pending") as GoalRecord["status"]),
          createdAt: pickByColumn<string>(row, map, 4, "createdAt", "created_at"),
          updatedAt: pickByColumn<string>(row, map, 5, "updatedAt", "updated_at")
        };
      }
    }
    return null;
  }

  async updateStatus(goalId: string, status: GoalStatus) {
    const values = await getSheetValues(GOALS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    const idCol0 = map ? (resolveColumnIndex(map, "id") ?? 1) - 1 : 0;
    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      if (((row[idCol0] || "") as string) === goalId) {
        const statusCol = map ? resolveColumnIndex(map, "status") : 4;
        const updatedCol = map ? resolveColumnIndex(map, "updatedAt", "updated_at") : 6;
        await updateCell(GOALS_SHEET, i + 1, statusCol || 4, status);
        await updateCell(GOALS_SHEET, i + 1, updatedCol || 6, new Date().toISOString());
        return true;
      }
    }
    return false;
  }
}

class SheetsTasksRepository implements TasksRepository {
  async add(task: TaskRecord) {
    const header = await getHeaderInfo(TASKS_SHEET);
    if (!header) {
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
      return;
    }

    const row: (string | number | null)[] = Array.from({ length: header.headerLength }, () => "");
    setByColumn(row, header.map, task.id, "id");
    setByColumn(row, header.map, task.goalId, "goalId", "goal_id");
    setByColumn(row, header.map, task.description, "description");
    setByColumn(row, header.map, task.status, "status");
    setByColumn(row, header.map, task.dueDate, "dueDate", "due_date");
    setByColumn(row, header.map, task.priority, "priority");
    setByColumn(row, header.map, task.assignedAt, "assignedAt", "assigned_at");
    setByColumn(row, header.map, task.sourceLogId ?? "", "sourceLogId", "source_log_id");
    await appendRow(TASKS_SHEET, row);
  }

  async listTodos() {
    const values = await getSheetValues(TASKS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    const todos = values
      .slice(1)
      .map((row, index) => this.toRecord(row, index + 2, map))
      .filter(record => (record.status || "").trim().toLowerCase() === "todo");

    // Stable, user-friendly ordering:
    // 1) priority (A -> B -> C -> unknown)
    // 2) dueDate (earlier first; missing last)
    // 3) assignedAt (earlier first; missing last)
    // 4) sheet row order (earlier first)
    const priorityRank = (priority: string) => {
      const normalized = (priority || "").trim().toUpperCase();
      if (normalized === "A") return 0;
      if (normalized === "B") return 1;
      if (normalized === "C") return 2;
      return 9;
    };
    const timeOrInfinity = (value: string) => {
      const t = Date.parse((value || "").trim());
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };

    return todos.sort((a, b) => {
      const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDiff !== 0) return priorityDiff;

      const dueDiff = timeOrInfinity(a.dueDate) - timeOrInfinity(b.dueDate);
      if (dueDiff !== 0) return dueDiff;

      const assignedDiff = timeOrInfinity(a.assignedAt) - timeOrInfinity(b.assignedAt);
      if (assignedDiff !== 0) return assignedDiff;

      return (a.rowIndex ?? 0) - (b.rowIndex ?? 0);
    });
  }

  async findNextTodo() {
    const todos = await this.listTodos();
    return todos[0] ?? null;
  }

  async findById(taskId: string) {
    const match = await this.findRowById(taskId);
    if (!match) return null;
    return this.toRecord(match.row, match.rowIndex, match.map);
  }

  async updateStatus(taskId: string, status: string) {
    const match = await this.findRowById(taskId);
    if (!match) return false;
    const map = await getColumnMap(TASKS_SHEET);
    const col = map ? resolveColumnIndex(map, "status") : 4;
    await updateCell(TASKS_SHEET, match.rowIndex, col || 4, status);
    return true;
  }

  async updateDueDate(taskId: string, dueDate: string) {
    const match = await this.findRowById(taskId);
    if (!match) return false;
    const map = await getColumnMap(TASKS_SHEET);
    const col = map ? resolveColumnIndex(map, "dueDate", "due_date") : 5;
    await updateCell(TASKS_SHEET, match.rowIndex, col || 5, dueDate);
    return true;
  }

  async updatePriority(taskId: string, priority: string) {
    const match = await this.findRowById(taskId);
    if (!match) return false;
    const map = await getColumnMap(TASKS_SHEET);
    const col = map ? resolveColumnIndex(map, "priority") : 6;
    await updateCell(TASKS_SHEET, match.rowIndex, col || 6, priority);
    return true;
  }

  private async findRowById(taskId: string): Promise<{ row: string[]; rowIndex: number; map: ColumnMap | null } | null> {
    const values = await getSheetValues(TASKS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    const idCol0 = map ? (resolveColumnIndex(map, "id") ?? 1) - 1 : 0;
    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      if (((row[idCol0] || "") as string) === taskId) {
        return { row, rowIndex: i + 1, map };
      }
    }
    return null;
  }

  async listByGoalId(goalId: string) {
    const values = await getSheetValues(TASKS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    return values
      .slice(1)
      .map((row, index) => this.toRecord(row, index + 2, map))
      .filter(record => record.goalId === goalId);
  }

  async countByGoalAndStatus(goalId: string, status: string) {
    const tasks = await this.listByGoalId(goalId);
    return tasks.filter(task => task.status.toLowerCase() === status.toLowerCase()).length;
  }

  private toRecord(row: string[], rowIndex: number | undefined, map: ColumnMap | null): TaskRecord {
    return {
      id: pickByColumn<string>(row, map, 0, "id"),
      goalId: pickByColumn<string>(row, map, 1, "goalId", "goal_id"),
      description: pickByColumn<string>(row, map, 2, "description"),
      status: pickByColumn<string>(row, map, 3, "status"),
      dueDate: pickByColumn<string>(row, map, 4, "dueDate", "due_date"),
      priority: pickByColumn<string>(row, map, 5, "priority"),
      assignedAt: pickByColumn<string>(row, map, 6, "assignedAt", "assigned_at"),
      sourceLogId: pickByColumn<string>(row, map, 7, "sourceLogId", "source_log_id"),
      rowIndex
    };
  }
}

class SheetsLogsRepository implements LogsRepository {
  async add(log: LogRecord) {
    const header = await getHeaderInfo(LOGS_SHEET);
    if (!header) {
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
      return;
    }

    const row: (string | number | null)[] = Array.from({ length: header.headerLength }, () => "");
    setByColumn(row, header.map, log.id, "id");
    setByColumn(row, header.map, log.timestamp, "timestamp");
    setByColumn(row, header.map, log.userId, "userId", "user_id");
    setByColumn(row, header.map, log.rawText, "rawText", "raw_text");
    setByColumn(row, header.map, log.emotion, "emotion");
    setByColumn(row, header.map, log.coreIssue, "coreIssue", "core_issue");
    setByColumn(row, header.map, log.currentGoal, "currentGoal", "current_goal");
    setByColumn(row, header.map, log.todayTask, "todayTask", "today_task");
    setByColumn(row, header.map, log.warning, "warning");
    await appendRow(LOGS_SHEET, row);
  }

  async listRecent(days: number, limit: number) {
    const values = await getSheetValues(LOGS_SHEET);
    const map = values[0]?.length ? buildColumnMap(values[0]) : null;
    const rows = values.slice(1);
    if (!rows.length) return [];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return rows
      .filter(row => {
        const time = Date.parse(pickByColumn<string>(row, map, 1, "timestamp") || "");
        return !Number.isNaN(time) && time >= cutoff;
      })
      .slice(-limit)
      .map(row => ({
        id: pickByColumn<string>(row, map, 0, "id"),
        timestamp: pickByColumn<string>(row, map, 1, "timestamp"),
        userId: pickByColumn<string>(row, map, 2, "userId", "user_id"),
        rawText: pickByColumn<string>(row, map, 3, "rawText", "raw_text"),
        emotion: pickByColumn<string>(row, map, 4, "emotion"),
        coreIssue: pickByColumn<string>(row, map, 5, "coreIssue", "core_issue"),
        currentGoal: pickByColumn<string>(row, map, 6, "currentGoal", "current_goal"),
        todayTask: pickByColumn<string>(row, map, 7, "todayTask", "today_task"),
        warning: pickByColumn<string>(row, map, 8, "warning")
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
