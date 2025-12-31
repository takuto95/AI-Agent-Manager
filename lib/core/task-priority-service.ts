import { TasksRepository, TaskRecord } from "../storage/repositories";

export class TaskPriorityService {
  private tasksRepo: TasksRepository;

  constructor(tasksRepo: TasksRepository) {
    this.tasksRepo = tasksRepo;
  }

  /**
   * 期限とmiss回数に基づいてタスクの優先度を自動調整
   */
  async adjustPriorities(): Promise<{ adjusted: TaskRecord[]; suggestions: string[] }> {
    const allTasks = await this.tasksRepo.listAll();
    const adjusted: TaskRecord[] = [];
    const suggestions: string[] = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const task of allTasks) {
      if (task.status.toLowerCase() !== "todo") continue;

      let shouldAdjust = false;
      let newPriority = task.priority || "B";
      let reason = "";

      // 期限が近い（3日以内）→ 優先度をAに
      if (task.dueDate) {
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysUntilDue = Math.floor((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntilDue >= 0 && daysUntilDue <= 3 && newPriority !== "A") {
          newPriority = "A";
          shouldAdjust = true;
          reason = `期限まで${daysUntilDue}日のため、優先度を上げました`;
        }
      }

      // 優先度が変更された場合
      if (shouldAdjust && newPriority !== task.priority) {
        await this.tasksRepo.updatePriority(task.id, newPriority);
        adjusted.push({ ...task, priority: newPriority });
        suggestions.push(`📌 ${task.description.substring(0, 30)}... → 優先度${newPriority} (${reason})`);
      }
    }

    return { adjusted, suggestions };
  }

  /**
   * miss回数が多いタスクを検出
   */
  async detectProblematicTasks(): Promise<string[]> {
    const allTasks = await this.tasksRepo.listAll();
    const missTasks = allTasks.filter(t => t.status.toLowerCase() === "miss");
    const suggestions: string[] = [];

    // ここでは簡易的に、missタスクが多い場合に警告
    if (missTasks.length > 5) {
      suggestions.push(
        `⚠️ 未達タスクが${missTasks.length}件あります。「split」コマンドで分割するか、優先度を見直しましょう。`
      );
    }

    return suggestions;
  }
}
