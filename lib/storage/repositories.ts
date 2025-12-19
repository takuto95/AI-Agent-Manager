export type GoalStatus = "pending" | "approved" | "archived";

export type GoalRecord = {
  id: string;
  title: string;
  confidence: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
};

export type TaskRecord = {
  id: string;
  goalId: string;
  description: string;
  status: string;
  dueDate: string;
  priority: string;
  assignedAt: string;
  sourceLogId?: string;
  rowIndex?: number;
};

export type LogRecord = {
  id: string;
  timestamp: string;
  userId: string;
  rawText: string;
  emotion: string;
  coreIssue: string;
  currentGoal: string;
  todayTask: string;
  warning: string;
};

export interface GoalsRepository {
  add(goal: GoalRecord): Promise<void>;
  list(): Promise<GoalRecord[]>;
}

export interface TasksRepository {
  add(task: TaskRecord): Promise<void>;
  listTodos(): Promise<TaskRecord[]>;
  findNextTodo(): Promise<TaskRecord | null>;
  findById(taskId: string): Promise<TaskRecord | null>;
  updateStatus(taskId: string, status: string): Promise<boolean>;
  updateDueDate(taskId: string, dueDate: string): Promise<boolean>;
  updatePriority(taskId: string, priority: string): Promise<boolean>;
}

export interface LogsRepository {
  add(log: LogRecord): Promise<void>;
  listRecent(days: number, limit: number): Promise<LogRecord[]>;
}

export type StorageContext = {
  goals: GoalsRepository;
  tasks: TasksRepository;
  logs: LogsRepository;
};
