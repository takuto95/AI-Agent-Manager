import { TasksRepository, TaskRecord } from "../storage/repositories";

export type UserPattern = {
  // 優先度別の傾向
  priorityStats: {
    A: { total: number; done: number; miss: number; rate: number };
    B: { total: number; done: number; miss: number; rate: number };
    C: { total: number; done: number; miss: number; rate: number };
  };
  
  // 曜日別の傾向（0=日曜、6=土曜）
  weekdayStats: {
    [key: number]: { total: number; done: number; miss: number; rate: number };
  };
  
  // よくmissするタスクのパターン
  missPatterns: {
    keywords: string[]; // よくmissするタスクに含まれるキーワード
    avgLength: number;  // missタスクの平均文字数
  };
  
  // よく完了するタスクのパターン
  donePatterns: {
    keywords: string[]; // よく完了するタスクに含まれるキーワード
    avgLength: number;  // 完了タスクの平均文字数
  };
  
  // 全体の傾向
  overall: {
    totalTasks: number;
    doneCount: number;
    missCount: number;
    overallRate: number;
  };
};

export type PersonalizedSuggestion = {
  type: "priority_adjustment" | "task_simplification" | "time_shift" | "encouragement";
  message: string;
  confidence: number; // 0-1, 提案の確信度
};

export class LearningService {
  constructor(private tasksRepo: TasksRepository) {}

  async analyzeUserPattern(): Promise<UserPattern> {
    const allTasks = await this.tasksRepo.listAll();
    const completedTasks = allTasks.filter(t => t.status === "done" || t.status === "miss");
    
    // 優先度別統計
    const priorityStats = {
      A: { total: 0, done: 0, miss: 0, rate: 0 },
      B: { total: 0, done: 0, miss: 0, rate: 0 },
      C: { total: 0, done: 0, miss: 0, rate: 0 }
    };
    
    for (const task of completedTasks) {
      const priority = (task.priority || "B").toUpperCase() as "A" | "B" | "C";
      if (!["A", "B", "C"].includes(priority)) continue;
      
      priorityStats[priority].total++;
      if (task.status === "done") {
        priorityStats[priority].done++;
      } else if (task.status === "miss") {
        priorityStats[priority].miss++;
      }
    }
    
    for (const priority of ["A", "B", "C"] as const) {
      const total = priorityStats[priority].total;
      priorityStats[priority].rate = total > 0 ? priorityStats[priority].done / total : 0;
    }
    
    // 曜日別統計
    const weekdayStats: { [key: number]: { total: number; done: number; miss: number; rate: number } } = {};
    for (let i = 0; i < 7; i++) {
      weekdayStats[i] = { total: 0, done: 0, miss: 0, rate: 0 };
    }
    
    for (const task of completedTasks) {
      if (!task.assignedAt) continue;
      const date = new Date(task.assignedAt);
      const weekday = date.getDay();
      
      weekdayStats[weekday].total++;
      if (task.status === "done") {
        weekdayStats[weekday].done++;
      } else if (task.status === "miss") {
        weekdayStats[weekday].miss++;
      }
    }
    
    for (let i = 0; i < 7; i++) {
      const total = weekdayStats[i].total;
      weekdayStats[i].rate = total > 0 ? weekdayStats[i].done / total : 0;
    }
    
    // missパターン分析
    const missTasks = completedTasks.filter(t => t.status === "miss");
    const missKeywords = this.extractKeywords(missTasks);
    const missAvgLength = missTasks.length > 0
      ? missTasks.reduce((sum, t) => sum + t.description.length, 0) / missTasks.length
      : 0;
    
    // doneパターン分析
    const doneTasks = completedTasks.filter(t => t.status === "done");
    const doneKeywords = this.extractKeywords(doneTasks);
    const doneAvgLength = doneTasks.length > 0
      ? doneTasks.reduce((sum, t) => sum + t.description.length, 0) / doneTasks.length
      : 0;
    
    // 全体統計
    const totalTasks = completedTasks.length;
    const doneCount = doneTasks.length;
    const missCount = missTasks.length;
    const overallRate = totalTasks > 0 ? doneCount / totalTasks : 0;
    
    return {
      priorityStats,
      weekdayStats,
      missPatterns: { keywords: missKeywords, avgLength: missAvgLength },
      donePatterns: { keywords: doneKeywords, avgLength: doneAvgLength },
      overall: { totalTasks, doneCount, missCount, overallRate }
    };
  }

  async generateSuggestions(): Promise<PersonalizedSuggestion[]> {
    const pattern = await this.analyzeUserPattern();
    const suggestions: PersonalizedSuggestion[] = [];
    
    // 優先度Aの達成率が低い → 優先度調整を提案
    if (pattern.priorityStats.A.total >= 5 && pattern.priorityStats.A.rate < 0.5) {
      suggestions.push({
        type: "priority_adjustment",
        message: `優先度Aのタスクの達成率が${Math.round(pattern.priorityStats.A.rate * 100)}%です。Aタスクを減らすか、優先度を見直しましょう。`,
        confidence: 0.8
      });
    }
    
    // missタスクの文字数が長い → タスク簡略化を提案
    if (pattern.missPatterns.avgLength > pattern.donePatterns.avgLength * 1.5 && pattern.overall.missCount >= 5) {
      suggestions.push({
        type: "task_simplification",
        message: `未達タスクは平均${Math.round(pattern.missPatterns.avgLength)}文字で、完了タスク（${Math.round(pattern.donePatterns.avgLength)}文字）より長いです。タスクを細かく分割してみましょう。`,
        confidence: 0.7
      });
    }
    
    // 特定の曜日の達成率が低い → 時間調整を提案
    const weekdayNames = ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"];
    for (let i = 0; i < 7; i++) {
      const stats = pattern.weekdayStats[i];
      if (stats.total >= 3 && stats.rate < 0.3) {
        suggestions.push({
          type: "time_shift",
          message: `${weekdayNames[i]}の達成率が${Math.round(stats.rate * 100)}%と低いです。この曜日は負担の少ないタスクを割り当てましょう。`,
          confidence: 0.6
        });
      }
    }
    
    // 全体の達成率が高い → 励ます
    if (pattern.overall.totalTasks >= 10 && pattern.overall.overallRate >= 0.7) {
      suggestions.push({
        type: "encouragement",
        message: `全体の達成率${Math.round(pattern.overall.overallRate * 100)}%！この調子でいきましょう。`,
        confidence: 1.0
      });
    }
    
    // 確信度でソート（高い順）
    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private extractKeywords(tasks: TaskRecord[]): string[] {
    // 簡易的なキーワード抽出（頻出する単語を抽出）
    const words: { [key: string]: number } = {};
    
    for (const task of tasks) {
      const tokens = task.description
        .replace(/[、。！？\s]+/g, " ")
        .split(" ")
        .filter(w => w.length >= 2);
      
      for (const token of tokens) {
        words[token] = (words[token] || 0) + 1;
      }
    }
    
    // 出現回数が多い順にソート
    const sorted = Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
    
    return sorted;
  }
}
