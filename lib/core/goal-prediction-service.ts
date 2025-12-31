import { GoalsRepository, TasksRepository, TaskRecord, GoalRecord } from "../storage/repositories";

export type GoalPrediction = {
  goalId: string;
  goalTitle: string;
  currentProgress: number; // 0.0 - 1.0
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  
  // 予測データ
  averageTasksPerWeek: number;
  weeksToCompletion: number;
  estimatedCompletionDate: string;
  confidence: "high" | "medium" | "low";
  
  // 推奨アクション
  recommendations: string[];
};

export type GoalAllocation = {
  goalId: string;
  goalTitle: string;
  currentProgress: number;
  priority: "urgent" | "high" | "normal" | "low";
  reason: string;
  recommendedTasksPerWeek: number;
};

export type RiskAlert = {
  goalId: string;
  goalTitle: string;
  riskLevel: "critical" | "warning" | "caution";
  riskType: "stagnation" | "overload" | "deadline_risk" | "imbalance";
  message: string;
  suggestedAction: string;
};

export class GoalPredictionService {
  private goalsRepo: GoalsRepository;
  private tasksRepo: TasksRepository;

  constructor(goalsRepo: GoalsRepository, tasksRepo: TasksRepository) {
    this.goalsRepo = goalsRepo;
    this.tasksRepo = tasksRepo;
  }

  /**
   * ゴールの達成予測を計算
   */
  async predictGoalCompletion(goalId: string): Promise<GoalPrediction | null> {
    const goal = await this.goalsRepo.findById(goalId);
    if (!goal) return null;

    const allTasks = await this.tasksRepo.listAll();
    const goalTasks = allTasks.filter(t => t.goalId === goalId);
    
    if (goalTasks.length === 0) {
      return null;
    }

    const completedTasks = goalTasks.filter(t => t.status.toLowerCase() === "done");
    const totalTasks = goalTasks.length;
    const remainingTasks = totalTasks - completedTasks.length;
    const currentProgress = totalTasks > 0 ? completedTasks.length / totalTasks : 0;

    // 過去4週間の完了ペースを計算
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    
    const recentCompletions = completedTasks.filter(t => {
      if (!t.assignedAt) return false;
      const assignedDate = new Date(t.assignedAt);
      return assignedDate >= fourWeeksAgo;
    });

    const averageTasksPerWeek = recentCompletions.length / 4;
    
    // 完了予測
    let weeksToCompletion = 0;
    let estimatedCompletionDate = "";
    let confidence: "high" | "medium" | "low" = "low";
    
    if (averageTasksPerWeek > 0) {
      weeksToCompletion = Math.ceil(remainingTasks / averageTasksPerWeek);
      const completionDate = new Date();
      completionDate.setDate(completionDate.getDate() + weeksToCompletion * 7);
      estimatedCompletionDate = completionDate.toISOString().split("T")[0];
      
      // 信頼度の判定
      if (recentCompletions.length >= 4) {
        confidence = "high";
      } else if (recentCompletions.length >= 2) {
        confidence = "medium";
      } else {
        confidence = "low";
      }
    }

    // 推奨アクション
    const recommendations: string[] = [];
    
    if (averageTasksPerWeek === 0) {
      recommendations.push("このゴールは最近進んでいません。週に1-2タスク取り組みましょう。");
    } else if (averageTasksPerWeek < 1) {
      recommendations.push("ペースが遅いです。週に2-3タスクに増やすと、より早く達成できます。");
    } else if (currentProgress > 0.7) {
      recommendations.push("あと少しです！ラストスパートをかけましょう。");
    }
    
    if (weeksToCompletion > 12) {
      recommendations.push("達成まで3ヶ月以上かかる見込み。タスクを細分化するか、優先度を上げましょう。");
    }

    return {
      goalId,
      goalTitle: goal.title,
      currentProgress,
      completedTasks: completedTasks.length,
      totalTasks,
      remainingTasks,
      averageTasksPerWeek,
      weeksToCompletion,
      estimatedCompletionDate,
      confidence,
      recommendations
    };
  }

  /**
   * 全ゴールの達成予測を取得
   */
  async predictAllGoals(): Promise<GoalPrediction[]> {
    const goals = await this.goalsRepo.list();
    const activeGoals = goals.filter(g => g.status !== "archived");
    
    const predictions: GoalPrediction[] = [];
    for (const goal of activeGoals) {
      const prediction = await this.predictGoalCompletion(goal.id);
      if (prediction) {
        predictions.push(prediction);
      }
    }
    
    return predictions;
  }

  /**
   * タスク配分の最適化提案
   */
  async optimizeTaskAllocation(): Promise<GoalAllocation[]> {
    const predictions = await this.predictAllGoals();
    const allocations: GoalAllocation[] = [];

    for (const pred of predictions) {
      let priority: "urgent" | "high" | "normal" | "low" = "normal";
      let reason = "";
      let recommendedTasksPerWeek = 2;

      // 停滞しているゴール
      if (pred.averageTasksPerWeek === 0) {
        priority = "urgent";
        reason = "完全に停滞しています。すぐに着手が必要です。";
        recommendedTasksPerWeek = 3;
      }
      // 進捗が遅いゴール
      else if (pred.averageTasksPerWeek < 1 && pred.currentProgress < 0.3) {
        priority = "high";
        reason = "進捗が遅れています。優先的に取り組みましょう。";
        recommendedTasksPerWeek = 3;
      }
      // もうすぐ完了
      else if (pred.currentProgress > 0.7) {
        priority = "high";
        reason = "あと少しで完了！集中して仕上げましょう。";
        recommendedTasksPerWeek = 4;
      }
      // 順調
      else if (pred.averageTasksPerWeek >= 2) {
        priority = "normal";
        reason = "順調なペースです。この調子を維持しましょう。";
        recommendedTasksPerWeek = 2;
      }
      // ペース遅め
      else {
        priority = "normal";
        reason = "現在のペースは悪くありませんが、もう少し加速できます。";
        recommendedTasksPerWeek = 2;
      }

      allocations.push({
        goalId: pred.goalId,
        goalTitle: pred.goalTitle,
        currentProgress: pred.currentProgress,
        priority,
        reason,
        recommendedTasksPerWeek
      });
    }

    // 優先度順にソート
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    allocations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return allocations;
  }

  /**
   * リスク検知
   */
  async detectRisks(): Promise<RiskAlert[]> {
    const predictions = await this.predictAllGoals();
    const alerts: RiskAlert[] = [];
    const allTasks = await this.tasksRepo.listAll();

    for (const pred of predictions) {
      // リスク1: 停滞（2週間以上進んでいない）
      if (pred.averageTasksPerWeek === 0 && pred.currentProgress < 1.0) {
        alerts.push({
          goalId: pred.goalId,
          goalTitle: pred.goalTitle,
          riskLevel: "critical",
          riskType: "stagnation",
          message: `「${pred.goalTitle}」は2週間以上進んでいません。`,
          suggestedAction: "週に1-2タスク取り組む計画を立てましょう。タスクが大きすぎる場合は分割を検討してください。"
        });
      }

      // リスク2: ペースが遅い（完了まで6ヶ月以上）
      if (pred.weeksToCompletion > 24 && pred.currentProgress < 0.5) {
        alerts.push({
          goalId: pred.goalId,
          goalTitle: pred.goalTitle,
          riskLevel: "warning",
          riskType: "deadline_risk",
          message: `「${pred.goalTitle}」は現在のペースだと完了まで半年以上かかります。`,
          suggestedAction: "ペースを上げるか、ゴールを見直しましょう。週に3-4タスク取り組むと約3ヶ月で達成できます。"
        });
      }

      // リスク3: タスク過多（未完了タスクが20個以上）
      const goalTasks = allTasks.filter(t => t.goalId === pred.goalId);
      const todoTasks = goalTasks.filter(t => t.status.toLowerCase() === "todo");
      if (todoTasks.length > 20) {
        alerts.push({
          goalId: pred.goalId,
          goalTitle: pred.goalTitle,
          riskLevel: "caution",
          riskType: "overload",
          message: `「${pred.goalTitle}」は未完了タスクが${todoTasks.length}個あります。`,
          suggestedAction: "タスクが多すぎると圧倒されます。優先度の低いタスクをアーカイブするか、サブゴールに分割しましょう。"
        });
      }
    }

    // 全ゴールのバランスチェック
    if (predictions.length > 1) {
      const progressVariance = this.calculateProgressVariance(predictions);
      if (progressVariance > 0.3) {
        // 進捗のバラツキが大きい
        const slowestGoal = predictions.reduce((min, p) => 
          p.currentProgress < min.currentProgress ? p : min
        );
        alerts.push({
          goalId: slowestGoal.goalId,
          goalTitle: slowestGoal.goalTitle,
          riskLevel: "caution",
          riskType: "imbalance",
          message: `ゴール間の進捗にバラツキがあります。「${slowestGoal.goalTitle}」が遅れています。`,
          suggestedAction: "進捗が遅いゴールに週に1-2タスク追加で取り組みましょう。"
        });
      }
    }

    return alerts;
  }

  /**
   * 進捗のバラツキ（分散）を計算
   */
  private calculateProgressVariance(predictions: GoalPrediction[]): number {
    if (predictions.length === 0) return 0;
    
    const mean = predictions.reduce((sum, p) => sum + p.currentProgress, 0) / predictions.length;
    const variance = predictions.reduce((sum, p) => sum + Math.pow(p.currentProgress - mean, 2), 0) / predictions.length;
    
    return Math.sqrt(variance); // 標準偏差
  }

  /**
   * 週次サマリーの生成
   */
  async generateWeeklySummary(): Promise<string> {
    const predictions = await this.predictAllGoals();
    const allocations = await this.optimizeTaskAllocation();
    const risks = await this.detectRisks();

    let summary = "📊 **週次ゴールサマリー**\n\n";

    // ゴール進捗概要
    summary += "**進捗状況:**\n";
    for (const pred of predictions) {
      const progressPercent = Math.round(pred.currentProgress * 100);
      const emoji = progressPercent >= 70 ? "🟢" : progressPercent >= 40 ? "🟡" : "🔴";
      summary += `${emoji} ${pred.goalTitle}: ${progressPercent}% (${pred.completedTasks}/${pred.totalTasks})\n`;
      
      if (pred.estimatedCompletionDate) {
        summary += `  └ 予測完了: ${pred.estimatedCompletionDate} (約${pred.weeksToCompletion}週間後)\n`;
      }
    }

    // 優先ゴール
    summary += "\n**今週注力すべきゴール:**\n";
    const topAllocations = allocations.slice(0, 3);
    for (const alloc of topAllocations) {
      const priorityEmoji = alloc.priority === "urgent" ? "🚨" : alloc.priority === "high" ? "⚡" : "📌";
      summary += `${priorityEmoji} ${alloc.goalTitle}\n`;
      summary += `  理由: ${alloc.reason}\n`;
      summary += `  推奨: 週に${alloc.recommendedTasksPerWeek}タスク\n`;
    }

    // リスクアラート
    if (risks.length > 0) {
      summary += "\n**⚠️ リスクアラート:**\n";
      for (const risk of risks) {
        const levelEmoji = risk.riskLevel === "critical" ? "🔴" : risk.riskLevel === "warning" ? "🟡" : "🟠";
        summary += `${levelEmoji} ${risk.message}\n`;
        summary += `  対策: ${risk.suggestedAction}\n`;
      }
    } else {
      summary += "\n✅ リスクなし。順調です！\n";
    }

    return summary;
  }
}
