import { TasksRepository } from "../storage/repositories";

const FALLBACK_TASK = "今日は何もしない。最低でもログを残せ。";

export class TaskPlannerService {
  constructor(private tasksRepo: TasksRepository) {}

  async getTodayTaskDescription(): Promise<string> {
    const next = await this.tasksRepo.findNextTodo();
    return next?.description?.trim() || FALLBACK_TASK;
  }
}
