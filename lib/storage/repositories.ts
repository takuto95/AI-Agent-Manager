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
  reason?: string;
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
  findById(goalId: string): Promise<GoalRecord | null>;
  updateStatus(goalId: string, status: GoalStatus): Promise<boolean>;
}

export type GoalProgress = {
  goal: GoalRecord;
  totalTasks: number;
  completedTasks: number;
  progressPercent: number;
};

export interface TasksRepository {
  add(task: TaskRecord): Promise<void>;
  listTodos(): Promise<TaskRecord[]>;
  listAll(): Promise<TaskRecord[]>;
  findNextTodo(): Promise<TaskRecord | null>;
  findById(taskId: string): Promise<TaskRecord | null>;
  updateStatus(taskId: string, status: string): Promise<boolean>;
  updateDueDate(taskId: string, dueDate: string): Promise<boolean>;
  updatePriority(taskId: string, priority: string): Promise<boolean>;
  listByGoalId(goalId: string): Promise<TaskRecord[]>;
  countByGoalAndStatus(goalId: string, status: string): Promise<number>;
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

export async function calculateGoalProgress(
  goalId: string,
  goals: GoalsRepository,
  tasks: TasksRepository
): Promise<GoalProgress | null> {
  const goal = await goals.findById(goalId);
  if (!goal) return null;

  const allTasks = await tasks.listByGoalId(goalId);
  const completedTasks = await tasks.countByGoalAndStatus(goalId, "done");
  const totalTasks = allTasks.length;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return {
    goal,
    totalTasks,
    completedTasks,
    progressPercent
  };
}

export async function listActiveGoalProgress(
  goals: GoalsRepository,
  tasks: TasksRepository
): Promise<GoalProgress[]> {
  const allGoals = await goals.list();
  const activeGoals = allGoals.filter(g => g.status === "approved" || g.status === "pending");
  
  const progress: GoalProgress[] = [];
  for (const goal of activeGoals) {
    const p = await calculateGoalProgress(goal.id, goals, tasks);
    if (p) progress.push(p);
  }
  
  return progress.sort((a, b) => b.progressPercent - a.progressPercent);
}
