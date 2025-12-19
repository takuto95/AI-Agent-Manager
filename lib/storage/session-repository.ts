import { appendRow, getSheetValues } from "../adapters/sheets";

const SESSION_SHEET = "sessions";

export type SessionMode = "log" | "daily" | "system";

type SessionEventType =
  | "start"
  | "user"
  | "assistant"
  | "end"
  | "analysis"
  | "daily_task_selection"
  | "daily_update"
  | "daily_review"
  | "daily_review_apply"
  | "morning_order";

export type SessionEvent = {
  sessionId: string;
  userId: string;
  type: SessionEventType;
  content: string;
  timestamp: string;
  meta?: string;
};

export type SessionTranscript = {
  sessionId: string;
  userId: string;
  events: SessionEvent[];
};

function nowISO() {
  return new Date().toISOString();
}

function buildSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function rowToEvent(row: string[]): SessionEvent | null {
  if (!row[0]) {
    return null;
  }

  return {
    sessionId: row[0],
    userId: row[1] || "",
    type: (row[2] as SessionEventType) || "user",
    content: row[3] || "",
    timestamp: row[4] || "",
    meta: row[5] || ""
  };
}

function encodeMeta(data: Record<string, unknown>) {
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

function parseMode(meta?: string): SessionMode {
  if (!meta) return "log";
  try {
    const parsed = JSON.parse(meta) as { mode?: SessionMode };
    if (parsed.mode === "daily") return "daily";
    if (parsed.mode === "system") return "system";
    return "log";
  } catch {
    if (meta.includes("daily")) return "daily";
    if (meta.includes("system")) return "system";
    return "log";
  }
}

export class SessionRepository {
  async start(userId: string, mode: SessionMode = "log"): Promise<SessionTranscript> {
    const sessionId = buildSessionId();
    const event: SessionEvent = {
      sessionId,
      userId,
      type: "start",
      content: "session_start",
      timestamp: nowISO(),
      meta: encodeMeta({ mode })
    };

    await this.record(event);

    return { sessionId, userId, events: [event] };
  }

  async appendUserMessage(sessionId: string, userId: string, content: string) {
    await this.record({
      sessionId,
      userId,
      type: "user",
      content,
      timestamp: nowISO()
    });
  }

  async appendAssistantMessage(sessionId: string, userId: string, content: string) {
    await this.record({
      sessionId,
      userId,
      type: "assistant",
      content,
      timestamp: nowISO()
    });
  }

  async end(sessionId: string, userId: string, meta?: string) {
    await this.record({
      sessionId,
      userId,
      type: "end",
      content: "session_end",
      meta,
      timestamp: nowISO()
    });
  }

  async getActiveSession(userId: string): Promise<SessionTranscript | null> {
    const sessions = await this.listSessions(userId);
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      const candidate = sessions[i];
      const hasEnded = candidate.events.some(event => event.type === "end");
      if (!hasEnded) {
        return candidate;
      }
    }

    return null;
  }

  async listSessions(userId: string): Promise<SessionTranscript[]> {
    const events = await this.fetchEventsForUser(userId);
    if (!events.length) {
      return [];
    }

    const grouped = new Map<string, SessionEvent[]>();
    for (const event of events) {
      const current = grouped.get(event.sessionId) ?? [];
      current.push(event);
      grouped.set(event.sessionId, current);
    }

    const transcripts: SessionTranscript[] = [];
    for (const [sessionId, sessionEvents] of grouped.entries()) {
      const sortedEvents = [...sessionEvents].sort((a, b) => {
        const aTime = Date.parse(a.timestamp || "0");
        const bTime = Date.parse(b.timestamp || "0");
        return aTime - bTime;
      });
      transcripts.push({
        sessionId,
        userId,
        events: sortedEvents
      });
    }

    return transcripts.sort((a, b) => {
      const aTime = Date.parse(a.events[a.events.length - 1]?.timestamp || "0");
      const bTime = Date.parse(b.events[b.events.length - 1]?.timestamp || "0");
      return aTime - bTime;
    });
  }

  async markAnalyzed(sessionId: string, userId: string, logId: string) {
    await this.record({
      sessionId,
      userId,
      type: "analysis",
      content: "analysis_complete",
      timestamp: nowISO(),
      meta: logId
    });
  }

  async appendDailyUpdate(sessionId: string, userId: string, payload: string) {
    await this.record({
      sessionId,
      userId,
      type: "daily_update",
      content: payload,
      timestamp: nowISO()
    });
  }

  async appendDailyTaskSelection(sessionId: string, userId: string, payload: string) {
    await this.record({
      sessionId,
      userId,
      type: "daily_task_selection",
      content: payload,
      timestamp: nowISO()
    });
  }

  async appendDailyReview(sessionId: string, userId: string, payload: string) {
    await this.record({
      sessionId,
      userId,
      type: "daily_review",
      content: payload,
      timestamp: nowISO()
    });
  }

  async appendDailyReviewApply(sessionId: string, userId: string, payload: string) {
    await this.record({
      sessionId,
      userId,
      type: "daily_review_apply",
      content: payload,
      timestamp: nowISO()
    });
  }

  async recordMorningOrder(userId: string, taskId: string) {
    // Record as a closed "system" session so it never blocks log/daily sessions.
    const session = await this.start(userId, "system");
    await this.record({
      sessionId: session.sessionId,
      userId,
      type: "morning_order",
      content: taskId,
      timestamp: nowISO()
    });
    await this.end(session.sessionId, userId, "morning_order");
    return session.sessionId;
  }

  async findLatestMorningOrderTaskId(userId: string): Promise<string | null> {
    const sessions = await this.listSessions(userId);
    let latest: { taskId: string; time: number } | null = null;
    for (const session of sessions) {
      for (const event of session.events) {
        if (event.type !== "morning_order") continue;
        const t = Date.parse(event.timestamp || "0");
        if (!latest || t >= latest.time) {
          latest = { taskId: event.content || "", time: t };
        }
      }
    }
    const taskId = (latest?.taskId || "").trim();
    return taskId ? taskId : null;
  }

  private async record(event: SessionEvent) {
    await appendRow(SESSION_SHEET, [
      event.sessionId,
      event.userId,
      event.type,
      event.content,
      event.timestamp,
      event.meta ?? ""
    ]);
  }

  private async fetchEventsForUser(userId: string) {
    const values = await getSheetValues(SESSION_SHEET);
    return values
      .slice(1)
      .map(rowToEvent)
      .filter((event): event is SessionEvent => !!event && event.userId === userId);
  }

  static getSessionMode(session: SessionTranscript): SessionMode {
    const startEvent = session.events.find(event => event.type === "start");
    return parseMode(startEvent?.meta);
  }
}
