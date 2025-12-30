export type AnalysisTask = {
  description: string;
  priority?: string;
  dueDate?: string;
  reason?: string;
};

export type AnalysisResult = {
  emotion: string;
  coreIssue: string;
  currentGoal: string;
  todayTask: string;
  warning: string;
  tasks: AnalysisTask[];
};

export type GoalIntakePayload = {
  userId: string;
  text: string;
  timestamp?: string;
};

export type GoalIntakeResult = {
  logId: string;
  timestamp: string;
  aiRaw: string;
  parsed: AnalysisResult | null;
};
