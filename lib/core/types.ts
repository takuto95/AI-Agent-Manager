export type AnalysisResult = {
  emotion: string;
  coreIssue: string;
  currentGoal: string;
  todayTask: string;
  warning: string;
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
