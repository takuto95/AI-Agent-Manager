import { TasksRepository, TaskRecord, LogsRepository } from "../storage/repositories";

export type UserBehaviorPattern = {
  // 曜日別の傾向（0=日曜〜6=土曜）
  weekdayPerformance: Record<number, { done: number; miss: number; total: number; rate: number }>;
  
  // 時間帯別の傾向（朝・昼・夜）
  timeOfDayPreference: {
    morning: number;   // 朝（6-12時）の完了率
    afternoon: number; // 昼（12-18時）の完了率
    evening: number;   // 夜（18-24時）の完了率
  };
  
  // タスクタイプ別の傾向
  taskTypePreference: {
    reading: number;    // 読む系タスクの完了率
    writing: number;    // 書く系タスクの完了率
    meeting: number;    // 会議系タスクの完了率
    research: number;   // 調べる系タスクの完了率
    creative: number;   // 作る系タスクの完了率
  };
  
  // 全体の傾向
  overallStats: {
    totalTasks: number;
    doneCount: number;
    missCount: number;
    averageCompletionRate: number;
  };
};

export class BehaviorLearningService {
  private tasksRepo: TasksRepository;
  private logsRepo: LogsRepository;

  constructor(tasksRepo: TasksRepository, logsRepo: LogsRepository) {
    this.tasksRepo = tasksRepo;
    this.logsRepo = logsRepo;
  }

  /**
   * ユーザーの行動パターンを分析
   */
  async analyzeUserBehavior(): Promise<UserBehaviorPattern> {
    const allTasks = await this.tasksRepo.listAll();
    const recentLogs = await this.logsRepo.listRecent(30, 100);

    // 曜日別の傾向
    const weekdayPerformance: UserBehaviorPattern["weekdayPerformance"] = {};
    for (let i = 0; i < 7; i++) {
      weekdayPerformance[i] = { done: 0, miss: 0, total: 0, rate: 0 };
    }

    for (const task of allTasks) {
      if (!task.assignedAt) continue;
      const date = new Date(task.assignedAt);
      const weekday = date.getDay();
      const status = task.status.toLowerCase();

      if (status === "done") {
        weekdayPerformance[weekday].done += 1;
        weekdayPerformance[weekday].total += 1;
      } else if (status === "miss") {
        weekdayPerformance[weekday].miss += 1;
        weekdayPerformance[weekday].total += 1;
      }
    }

    // 完了率を計算
    for (let i = 0; i < 7; i++) {
      const perf = weekdayPerformance[i];
      perf.rate = perf.total > 0 ? perf.done / perf.total : 0;
    }

    // タスクタイプ別の傾向
    const taskTypePreference = {
      reading: this.calculateTypeRate(allTasks, ["読", "確認", "レビュー"]),
      writing: this.calculateTypeRate(allTasks, ["書", "作成", "執筆", "記録"]),
      meeting: this.calculateTypeRate(allTasks, ["会議", "ミーティング", "打ち合わせ"]),
      research: this.calculateTypeRate(allTasks, ["調べ", "リサーチ", "検索", "調査"]),
      creative: this.calculateTypeRate(allTasks, ["作る", "デザイン", "設計", "考える"])
    };

    // 全体統計
    const doneCount = allTasks.filter(t => t.status.toLowerCase() === "done").length;
    const missCount = allTasks.filter(t => t.status.toLowerCase() === "miss").length;
    const totalTasks = doneCount + missCount;
    const averageCompletionRate = totalTasks > 0 ? doneCount / totalTasks : 0;

    return {
      weekdayPerformance,
      timeOfDayPreference: {
        morning: 0.7,   // 暫定値（今後ログから計算）
        afternoon: 0.6,
        evening: 0.5
      },
      taskTypePreference,
      overallStats: {
        totalTasks,
        doneCount,
        missCount,
        averageCompletionRate
      }
    };
  }

  private calculateTypeRate(tasks: TaskRecord[], keywords: string[]): number {
    const matching = tasks.filter(t =>
      keywords.some(kw => t.description.includes(kw))
    );
    if (matching.length === 0) return 0.5; // デフォルト

    const done = matching.filter(t => t.status.toLowerCase() === "done").length;
    return matching.length > 0 ? done / matching.length : 0.5;
  }

  /**
   * 曜日と時刻に基づいてタスクを提案
   */
  async suggestTasksForContext(
    weekday: number,
    hour: number
  ): Promise<{ suggestions: string[]; preferredTypes: string[] }> {
    const pattern = await this.analyzeUserBehavior();
    const suggestions: string[] = [];
    const preferredTypes: string[] = [];

    // 曜日別の傾向
    const todayPerf = pattern.weekdayPerformance[weekday];
    if (todayPerf && todayPerf.total >= 3) {
      if (todayPerf.rate < 0.3) {
        suggestions.push("この曜日は完了率が低い傾向があります。軽めのタスクを選びましょう。");
        preferredTypes.push("reading", "research");
      } else if (todayPerf.rate > 0.8) {
        suggestions.push("この曜日は完了率が高い！チャレンジングなタスクもいけそうです。");
        preferredTypes.push("writing", "creative");
      }
    }

    // 時間帯別の傾向
    if (hour >= 6 && hour < 12) {
      // 朝
      suggestions.push("朝は集中力が高い時間帯。重要なタスクに取り組みましょう。");
      preferredTypes.push("writing", "creative");
    } else if (hour >= 18) {
      // 夜
      suggestions.push("夜は軽めのタスクがおすすめ。読む・調べる系がいいでしょう。");
      preferredTypes.push("reading", "research");
    }

    return { suggestions, preferredTypes };
  }
}
