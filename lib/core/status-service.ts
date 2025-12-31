import { StorageContext, UserSettingsRecord, TaskRecord, GoalProgress, listActiveGoalProgress } from "../storage/repositories";
import { SessionRepository } from "../storage/session-repository";

/**
 * ステータス情報の型定義
 */
export type StatusInfo = {
  user: {
    userId: string;
    settings: UserSettingsRecord;
  };
  todayTask: {
    morningTask: TaskRecord | null;
    inProgressTasks: TaskRecord[];
  };
  goals: {
    activeGoals: GoalProgress[];
    totalGoals: number;
  };
  summary: {
    totalTodos: number;
    priorityA: number;
    priorityB: number;
    priorityC: number;
    overdueTasks: number;
  };
  recentActivity: {
    recentCompletedTasks: TaskRecord[];
    recentLogCount: number;
    streak: number;
  };
  statistics: {
    thisWeekCompleted: number;
    thisMonthCompleted: number;
    overallCompletionRate: number;
  };
  recommendations: string[];
};

/**
 * キャラクターロール名の表示用変換
 */
function getCharacterRoleLabel(role: UserSettingsRecord["characterRole"]): string {
  switch (role) {
    case "ceo": return "社長";
    case "heir": return "御曹司";
    case "athlete": return "アスリート";
    case "scholar": return "研究者";
    case "default": return "デフォルト（鬼コーチ）";
    default: return role;
  }
}

/**
 * メッセージトーン名の表示用変換
 */
function getMessageToneLabel(tone: UserSettingsRecord["messageTone"]): string {
  switch (tone) {
    case "strict": return "厳格（「〜しろ」「〜だ」）";
    case "formal": return "敬語（「〜してください」「〜です」）";
    case "friendly": return "フレンドリー（「〜しよう」「〜だね」）";
    default: return tone;
  }
}

/**
 * ストリーク（連続日数）を計算
 */
async function calculateStreak(userId: string, sessionRepo: SessionRepository): Promise<number> {
  const sessions = await sessionRepo.listSessions(userId);
  
  // daily セッションの日付を取得
  const dailyDates = new Set<string>();
  for (const session of sessions) {
    const startEvent = session.events.find(e => e.type === "start");
    if (!startEvent?.meta) continue;
    
    try {
      const meta = JSON.parse(startEvent.meta);
      if (meta.mode === "daily" && startEvent.timestamp) {
        const date = new Date(startEvent.timestamp).toISOString().split("T")[0];
        dailyDates.add(date);
      }
    } catch {
      // ignore parse errors
    }
  }
  
  // 日付を降順にソート
  const sortedDates = Array.from(dailyDates).sort().reverse();
  if (sortedDates.length === 0) return 0;
  
  // 連続日数を計算
  let streak = 0;
  const today = new Date().toISOString().split("T")[0];
  let currentDate = today;
  
  for (const date of sortedDates) {
    if (date === currentDate) {
      streak += 1;
      // 前日に移動
      const d = new Date(currentDate);
      d.setDate(d.getDate() - 1);
      currentDate = d.toISOString().split("T")[0];
    } else {
      break;
    }
  }
  
  return streak;
}

/**
 * 推奨アクションを生成
 */
function generateRecommendations(
  status: Omit<StatusInfo, "recommendations">
): string[] {
  const recommendations: string[] = [];
  
  // 朝のタスクがまだない場合
  if (!status.todayTask.morningTask) {
    recommendations.push("朝の命令がまだ設定されていません。朝ジョブが実行されるのを待ちましょう。");
  }
  
  // 期限切れタスクがある場合
  if (status.summary.overdueTasks > 0) {
    recommendations.push(`⚠️ 期限切れのタスクが${status.summary.overdueTasks}件あります。優先的に対処しましょう。`);
  }
  
  // ストリークが途切れそうな場合
  if (status.recentActivity.streak === 0) {
    recommendations.push("今日はまだ日報を記録していません。#日報開始で記録を始めましょう。");
  } else if (status.recentActivity.streak >= 3) {
    recommendations.push(`🔥 ${status.recentActivity.streak}日連続！この調子で続けましょう。`);
  }
  
  // ゴールが未設定の場合
  if (status.goals.totalGoals === 0) {
    recommendations.push("まだゴールが設定されていません。思考ログ（#整理開始）でゴールを見つけましょう。");
  }
  
  // タスクがない場合
  if (status.summary.totalTodos === 0) {
    recommendations.push("タスクがありません。思考ログ（#整理開始）で次のアクションを考えましょう。");
  }
  
  // 優先度Aが多すぎる場合
  if (status.summary.priorityA > 5) {
    recommendations.push("優先度Aのタスクが多すぎます。本当に重要なものに絞りましょう。");
  }
  
  // 完了率が低い場合
  if (status.statistics.overallCompletionRate < 50 && status.statistics.overallCompletionRate > 0) {
    recommendations.push("完了率が低めです。タスクを細かく分割してみましょう。");
  }
  
  return recommendations.slice(0, 3); // 最大3件
}

/**
 * ユーザーの現在のステータス情報を取得
 */
export async function getUserStatus(
  userId: string,
  storage: StorageContext,
  sessionRepo: SessionRepository
): Promise<StatusInfo> {
  // ユーザー設定を取得
  const settings = await storage.userSettings.getOrDefault(userId);

  // 朝の命令タスクを取得
  const morningTaskId = await sessionRepo.findLatestMorningOrderTaskId(userId);
  const morningTask = morningTaskId ? await storage.tasks.findById(morningTaskId) : null;

  // 全タスクを取得
  const allTasks = await storage.tasks.listAll();
  const allTodos = await storage.tasks.listTodos();
  const now = Date.now();
  const threeDaysFromNow = now + 3 * 24 * 60 * 60 * 1000;
  
  // 進行中のタスク（優先度A、期限が近いタスク）を取得
  const inProgressTasks = allTodos
    .filter(task => {
      // 朝の命令タスクは除外
      if (task.id === morningTaskId) return false;
      
      // 優先度Aまたは期限が3日以内のタスク
      const isHighPriority = task.priority?.toUpperCase() === "A";
      const hasDueSoon = task.dueDate && Date.parse(task.dueDate) <= threeDaysFromNow;
      
      return isHighPriority || hasDueSoon;
    })
    .slice(0, 3); // 最大3件

  // ゴール進捗を取得
  const activeGoals = await listActiveGoalProgress(storage.goals, storage.tasks);
  const allGoals = await storage.goals.list();

  // 最近完了したタスク
  const recentCompletedTasks = allTasks
    .filter(t => t.status?.toLowerCase() === "done")
    .sort((a, b) => {
      const aTime = a.assignedAt ? Date.parse(a.assignedAt) : 0;
      const bTime = b.assignedAt ? Date.parse(b.assignedAt) : 0;
      return bTime - aTime;
    })
    .slice(0, 3);

  // 最近のログ数（直近3日）
  const recentLogs = await storage.logs.listRecent(3, 100);
  const recentLogCount = recentLogs.length;

  // ストリーク計算
  const streak = await calculateStreak(userId, sessionRepo);

  // 統計情報
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  const thisWeekCompleted = allTasks.filter(t => {
    if (t.status?.toLowerCase() !== "done") return false;
    const time = t.assignedAt ? Date.parse(t.assignedAt) : 0;
    return time >= oneWeekAgo;
  }).length;

  const thisMonthCompleted = allTasks.filter(t => {
    if (t.status?.toLowerCase() !== "done") return false;
    const time = t.assignedAt ? Date.parse(t.assignedAt) : 0;
    return time >= oneMonthAgo;
  }).length;

  const completedCount = allTasks.filter(t => t.status?.toLowerCase() === "done").length;
  const totalCount = allTasks.length;
  const overallCompletionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // サマリー情報を計算
  const totalTodos = allTodos.length;
  const priorityA = allTodos.filter(t => t.priority?.toUpperCase() === "A").length;
  const priorityB = allTodos.filter(t => t.priority?.toUpperCase() === "B").length;
  const priorityC = allTodos.filter(t => t.priority?.toUpperCase() === "C").length;
  const overdueTasks = allTodos.filter(t => {
    if (!t.dueDate) return false;
    const dueTime = Date.parse(t.dueDate);
    return !Number.isNaN(dueTime) && dueTime < now;
  }).length;

  const statusWithoutRecommendations = {
    user: {
      userId,
      settings
    },
    todayTask: {
      morningTask,
      inProgressTasks
    },
    goals: {
      activeGoals: activeGoals.slice(0, 5), // 最大5件
      totalGoals: allGoals.length
    },
    summary: {
      totalTodos,
      priorityA,
      priorityB,
      priorityC,
      overdueTasks
    },
    recentActivity: {
      recentCompletedTasks,
      recentLogCount,
      streak
    },
    statistics: {
      thisWeekCompleted,
      thisMonthCompleted,
      overallCompletionRate
    }
  };

  const recommendations = generateRecommendations(statusWithoutRecommendations);

  return {
    ...statusWithoutRecommendations,
    recommendations
  };
}

/**
 * ステータス情報を整形して文字列に変換
 */
export function formatStatusInfo(status: StatusInfo): string {
  const lines: string[] = [];

  // ヘッダー
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("📊 現在のステータス");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  // ユーザー設定
  lines.push("👤 パーソナライズ設定");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push(`・キャラクター: ${getCharacterRoleLabel(status.user.settings.characterRole)}`);
  lines.push(`・メッセージトーン: ${getMessageToneLabel(status.user.settings.messageTone)}`);
  if (status.user.settings.displayName) {
    lines.push(`・表示名: ${status.user.settings.displayName}`);
  }
  lines.push("");
  lines.push("💡 変更するには:");
  lines.push("  #設定 キャラクター 社長");
  lines.push("  #設定 トーン 敬語");
  lines.push("  #設定 名前 田中");
  lines.push("");

  // 今日のタスク
  lines.push("🎯 今日のタスク");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  if (status.todayTask.morningTask) {
    const task = status.todayTask.morningTask;
    lines.push("【朝の命令】");
    lines.push(`  ${task.description}`);
    lines.push(`  ID: ${task.id} | 優先度: ${task.priority || "-"} | 期限: ${task.dueDate || "-"}`);
  } else {
    lines.push("【朝の命令】");
    lines.push("  まだ設定されていません");
  }
  
  if (status.todayTask.inProgressTasks.length > 0) {
    lines.push("");
    lines.push("【重要なタスク】");
    for (const task of status.todayTask.inProgressTasks) {
      lines.push(`  • ${task.description}`);
      lines.push(`    ID: ${task.id} | 優先度: ${task.priority || "-"} | 期限: ${task.dueDate || "-"}`);
    }
  }
  lines.push("");

  // ゴール進捗
  lines.push("🏆 ゴールと進捗");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  if (status.goals.activeGoals.length > 0) {
    for (const goalProgress of status.goals.activeGoals) {
      const progressBar = "█".repeat(Math.floor(goalProgress.progressPercent / 10)) + 
                         "░".repeat(10 - Math.floor(goalProgress.progressPercent / 10));
      lines.push(`${goalProgress.goal.title}`);
      lines.push(`  ${progressBar} ${goalProgress.progressPercent}%`);
      lines.push(`  完了: ${goalProgress.completedTasks}/${goalProgress.totalTasks}件`);
      lines.push("");
    }
    if (status.goals.totalGoals > status.goals.activeGoals.length) {
      lines.push(`...他 ${status.goals.totalGoals - status.goals.activeGoals.length} 件のゴール`);
      lines.push("");
    }
  } else {
    lines.push("まだゴールが設定されていません");
    lines.push("");
  }

  // タスクサマリー
  lines.push("📋 タスクサマリー");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push(`・残りタスク: ${status.summary.totalTodos}件`);
  lines.push(`  - 優先度A: ${status.summary.priorityA}件`);
  lines.push(`  - 優先度B: ${status.summary.priorityB}件`);
  lines.push(`  - 優先度C: ${status.summary.priorityC}件`);
  if (status.summary.overdueTasks > 0) {
    lines.push(`  - ⚠️ 期限切れ: ${status.summary.overdueTasks}件`);
  }
  lines.push("");

  // 最近の活動
  lines.push("📈 最近の活動");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  if (status.recentActivity.streak > 0) {
    lines.push(`🔥 連続: ${status.recentActivity.streak}日`);
  } else {
    lines.push(`連続: なし（今日から始めましょう！）`);
  }
  lines.push(`・直近3日の記録: ${status.recentActivity.recentLogCount}件`);
  
  if (status.recentActivity.recentCompletedTasks.length > 0) {
    lines.push("");
    lines.push("【最近完了したタスク】");
    for (const task of status.recentActivity.recentCompletedTasks) {
      lines.push(`  ✅ ${task.description}`);
    }
  }
  lines.push("");

  // 統計情報
  lines.push("📊 統計情報");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push(`・今週の完了: ${status.statistics.thisWeekCompleted}件`);
  lines.push(`・今月の完了: ${status.statistics.thisMonthCompleted}件`);
  lines.push(`・全体の完了率: ${status.statistics.overallCompletionRate}%`);
  lines.push("");

  // 推奨アクション
  if (status.recommendations.length > 0) {
    lines.push("💡 推奨アクション");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    for (const rec of status.recommendations) {
      lines.push(`・${rec}`);
    }
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("📱 使えるコマンド:");
  lines.push("  #日報開始 - 今日の進捗を記録");
  lines.push("  #整理開始 - 思考を整理");
  lines.push("  #ゴール進捗 <ゴール名> - 詳細確認");
  lines.push("  #設定 - パーソナライズ変更");

  return lines.join("\n");
}
