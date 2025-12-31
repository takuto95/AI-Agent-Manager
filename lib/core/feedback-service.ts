import { TasksRepository, TaskRecord } from "../storage/repositories";

export type TaskFeedback = {
  taskId: string;
  satisfied: boolean; // 👍 = true, 👎 = false
  timestamp: string;
};

export class FeedbackService {
  private tasksRepo: TasksRepository;
  private feedbackHistory: TaskFeedback[] = [];

  constructor(tasksRepo: TasksRepository) {
    this.tasksRepo = tasksRepo;
  }

  /**
   * タスク完了時のフィードバックを記録
   */
  recordFeedback(taskId: string, satisfied: boolean) {
    this.feedbackHistory.push({
      taskId,
      satisfied,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 満足度に基づく提案を生成
   */
  async generateSuggestions(): Promise<string[]> {
    if (this.feedbackHistory.length < 5) {
      return []; // データが少ないうちは提案しない
    }

    const recent = this.feedbackHistory.slice(-10);
    const satisfiedCount = recent.filter(f => f.satisfied).length;
    const satisfactionRate = satisfiedCount / recent.length;

    const suggestions: string[] = [];

    if (satisfactionRate < 0.5) {
      suggestions.push(
        "最近のタスク選定があまり合っていないようです。「変更」コマンドで別のタスクを選んでみてください。"
      );
    } else if (satisfactionRate > 0.8) {
      suggestions.push(
        "AIのタスク選定がうまく機能しているようです。この調子で進めましょう！"
      );
    }

    return suggestions;
  }
}
