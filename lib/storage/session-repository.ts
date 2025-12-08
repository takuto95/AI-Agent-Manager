import { appendRow, getSheetValues } from "../adapters/sheets";

const SESSION_SHEET = "sessions";

type SessionEventType = "start" | "user" | "assistant" | "end";

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

export class SessionRepository {
  async start(userId: string): Promise<SessionTranscript> {
    const sessionId = buildSessionId();
    const event: SessionEvent = {
      sessionId,
      userId,
      type: "start",
      content: "session_start",
      timestamp: nowISO()
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
    const events = await this.fetchEventsForUser(userId);
    if (!events.length) {
      return null;
    }

    const grouped = new Map<string, SessionEvent[]>();
    for (const event of events) {
      const current = grouped.get(event.sessionId) ?? [];
      current.push(event);
      grouped.set(event.sessionId, current);
    }

    const sessions = Array.from(grouped.values()).sort((a, b) => {
      const aTime = Date.parse(a[a.length - 1]?.timestamp || "0");
      const bTime = Date.parse(b[b.length - 1]?.timestamp || "0");
      return aTime - bTime;
    });

    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      const candidate = sessions[i];
      const hasEnded = candidate.some(event => event.type === "end");
      if (!hasEnded) {
        return {
          sessionId: candidate[0]?.sessionId || "",
          userId,
          events: candidate
        };
      }
    }

    return null;
  }

  async fetchSession(sessionId: string): Promise<SessionTranscript | null> {
    const values = await getSheetValues(SESSION_SHEET);
    const events = values
      .slice(1)
      .map(rowToEvent)
      .filter((event): event is SessionEvent => !!event && event.sessionId === sessionId);

    if (!events.length) {
      return null;
    }

    return {
      sessionId,
      userId: events[0].userId,
      events
    };
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
}
