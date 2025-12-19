import "dotenv/config";
import { getSheetValues, updateRow } from "../lib/adapters/sheets";

type ColumnMap = Map<string, number>; // normalized header -> 1-based column index

type SheetSchema<T extends Record<string, string>> = {
  sheetName: string;
  fields: Array<{
    key: keyof T;
    aliases: string[];
    legacyIndex: number;
  }>;
  validate(record: Partial<T>): boolean;
};

function normalizeHeaderName(value: string) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "");
}

function buildColumnMap(headerRow: string[]): ColumnMap {
  const map: ColumnMap = new Map();
  headerRow.forEach((name, idx) => {
    const normalized = normalizeHeaderName(name);
    if (!normalized) return;
    if (!map.has(normalized)) map.set(normalized, idx + 1);
  });
  return map;
}

function resolveColumnIndex(map: ColumnMap, ...aliases: string[]) {
  for (const alias of aliases) {
    const idx = map.get(normalizeHeaderName(alias));
    if (idx) return idx;
  }
  return null;
}

function pickByColumn(row: string[], map: ColumnMap | null, fallbackIndex: number, ...aliases: string[]) {
  const col = map ? resolveColumnIndex(map, ...aliases) : null;
  const idx0 = col ? col - 1 : fallbackIndex;
  return (row[idx0] || "").trim();
}

function setByColumn(row: (string | number | null)[], map: ColumnMap, value: string, ...aliases: string[]) {
  const col = resolveColumnIndex(map, ...aliases);
  if (!col) return false;
  const idx0 = col - 1;
  while (row.length <= idx0) row.push("");
  row[idx0] = value;
  return true;
}

function isIsoLike(s: string) {
  if (!s) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t);
}

function isPriority(s: string) {
  const v = (s || "").trim().toUpperCase();
  return v === "" || v === "A" || v === "B" || v === "C";
}

function isTaskStatus(s: string) {
  const v = (s || "").trim().toLowerCase();
  return v === "todo" || v === "done" || v === "miss";
}

function isGoalStatus(s: string) {
  const v = (s || "").trim().toLowerCase();
  return v === "pending" || v === "approved" || v === "archived";
}

function isSessionType(s: string) {
  const v = (s || "").trim();
  return [
    "start",
    "user",
    "assistant",
    "end",
    "analysis",
    "daily_task_selection",
    "daily_update",
    "daily_review",
    "daily_review_apply",
    "morning_order"
  ].includes(v);
}

function isNonEmpty(s: string) {
  return (s || "").trim().length > 0;
}

function idLooksLike(prefixes: string[], value: string) {
  const s = (value || "").trim();
  return prefixes.some(p => s.startsWith(p));
}

function parseRowByHeader<T extends Record<string, string>>(
  row: string[],
  map: ColumnMap | null,
  schema: SheetSchema<T>
): Partial<T> {
  const out: Partial<T> = {};
  for (const field of schema.fields) {
    const key = field.key as string;
    out[field.key] = pickByColumn(row, map, field.legacyIndex, ...field.aliases) as any;
    if (typeof out[field.key] === "string") {
      out[field.key] = (out[field.key] as string).trim() as any;
    }
  }
  return out;
}

function parseRowLegacy<T extends Record<string, string>>(row: string[], schema: SheetSchema<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const field of schema.fields) {
    out[field.key] = (row[field.legacyIndex] || "").trim() as any;
  }
  return out;
}

function buildRepairedRow<T extends Record<string, string>>(
  originalRow: string[],
  header: string[],
  map: ColumnMap,
  schema: SheetSchema<T>,
  record: Partial<T>
) {
  const newRow: (string | number | null)[] = [...originalRow];
  while (newRow.length < header.length) newRow.push("");
  for (const field of schema.fields) {
    const value = String(record[field.key] ?? "").trim();
    setByColumn(newRow, map, value, ...field.aliases);
  }
  return newRow.slice(0, header.length);
}

async function repairSheet<T extends Record<string, string>>(schema: SheetSchema<T>, apply: boolean, limit: number) {
  const values = await getSheetValues(schema.sheetName);
  const header = values[0] || [];
  if (!header.length) {
    console.log(`[skip] ${schema.sheetName}: header not found`);
    return;
  }
  const map = buildColumnMap(header);

  let scanned = 0;
  let aligned = 0;
  let repaired = 0;
  let skipped = 0;

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const rowIndex = i + 1; // 1-based in Sheets
    if (!row.some(cell => (cell || "").trim() !== "")) continue;

    scanned += 1;
    const current = parseRowByHeader(row, map, schema);
    if (schema.validate(current)) {
      aligned += 1;
      continue;
    }

    const legacy = parseRowLegacy(row, schema);
    if (!schema.validate(legacy)) {
      skipped += 1;
      continue;
    }

    const newRow = buildRepairedRow(row, header, map, schema, legacy);
    repaired += 1;

    if (apply) {
      await updateRow(schema.sheetName, rowIndex, newRow, "Z");
    }

    if (repaired >= limit) {
      break;
    }
  }

  console.log(
    `[${schema.sheetName}] scanned=${scanned} aligned=${aligned} repaired=${repaired}${apply ? " (applied)" : " (dry-run)"} skipped=${skipped}`
  );
}

function parseArgs(argv: string[]) {
  const args = new Set(argv);
  const apply = args.has("--apply");

  const limitFlagIdx = argv.findIndex(a => a === "--limit");
  const limitRaw = limitFlagIdx >= 0 ? argv[limitFlagIdx + 1] : null;
  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : Number.POSITIVE_INFINITY;

  const sheetFlagIdx = argv.findIndex(a => a === "--sheet");
  const sheet = sheetFlagIdx >= 0 ? (argv[sheetFlagIdx + 1] || "").trim() : "";

  return { apply, limit, sheet };
}

type GoalsRow = {
  id: string;
  title: string;
  confidence: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type TasksRow = {
  id: string;
  goalId: string;
  description: string;
  status: string;
  dueDate: string;
  priority: string;
  assignedAt: string;
  sourceLogId: string;
};

type LogsRow = {
  id: string;
  timestamp: string;
  userId: string;
  rawText: string;
  emotion: string;
  coreIssue: string;
  currentGoal: string;
  todayTask: string;
  warning: string;
};

type SessionsRow = {
  sessionId: string;
  userId: string;
  type: string;
  content: string;
  timestamp: string;
  meta: string;
};

const schemas: Array<SheetSchema<any>> = [
  {
    sheetName: "goals",
    fields: [
      { key: "id", aliases: ["id"], legacyIndex: 0 },
      { key: "title", aliases: ["title"], legacyIndex: 1 },
      { key: "confidence", aliases: ["confidence"], legacyIndex: 2 },
      { key: "status", aliases: ["status"], legacyIndex: 3 },
      { key: "createdAt", aliases: ["createdAt", "created_at"], legacyIndex: 4 },
      { key: "updatedAt", aliases: ["updatedAt", "updated_at"], legacyIndex: 5 }
    ],
    validate: (r: Partial<GoalsRow>) => {
      if (!idLooksLike(["g_"], r.id || "")) return false;
      if (!isNonEmpty(r.title || "")) return false;
      if (!isGoalStatus(r.status || "")) return false;
      if (!isIsoLike(r.createdAt || "")) return false;
      if (!isIsoLike(r.updatedAt || "")) return false;
      return true;
    }
  },
  {
    sheetName: "tasks",
    fields: [
      { key: "id", aliases: ["id"], legacyIndex: 0 },
      { key: "goalId", aliases: ["goalId", "goal_id"], legacyIndex: 1 },
      { key: "description", aliases: ["description"], legacyIndex: 2 },
      { key: "status", aliases: ["status"], legacyIndex: 3 },
      { key: "dueDate", aliases: ["dueDate", "due_date"], legacyIndex: 4 },
      { key: "priority", aliases: ["priority"], legacyIndex: 5 },
      { key: "assignedAt", aliases: ["assignedAt", "assigned_at"], legacyIndex: 6 },
      { key: "sourceLogId", aliases: ["sourceLogId", "source_log_id"], legacyIndex: 7 }
    ],
    validate: (r: Partial<TasksRow>) => {
      if (!idLooksLike(["t_"], r.id || "")) return false;
      if (!isNonEmpty(r.description || "")) return false;
      if (!isTaskStatus(r.status || "")) return false;
      if (!isPriority(r.priority || "")) return false;
      if (!isIsoLike(r.assignedAt || "")) return false;
      if ((r.dueDate || "").trim() && !isIsoLike(r.dueDate || "")) return false;
      return true;
    }
  },
  {
    sheetName: "logs",
    fields: [
      { key: "id", aliases: ["id"], legacyIndex: 0 },
      { key: "timestamp", aliases: ["timestamp"], legacyIndex: 1 },
      { key: "userId", aliases: ["userId", "user_id"], legacyIndex: 2 },
      { key: "rawText", aliases: ["rawText", "raw_text"], legacyIndex: 3 },
      { key: "emotion", aliases: ["emotion"], legacyIndex: 4 },
      { key: "coreIssue", aliases: ["coreIssue", "core_issue"], legacyIndex: 5 },
      { key: "currentGoal", aliases: ["currentGoal", "current_goal"], legacyIndex: 6 },
      { key: "todayTask", aliases: ["todayTask", "today_task"], legacyIndex: 7 },
      { key: "warning", aliases: ["warning"], legacyIndex: 8 }
    ],
    validate: (r: Partial<LogsRow>) => {
      if (!idLooksLike(["l_", "daily_"], r.id || "")) return false;
      if (!isIsoLike(r.timestamp || "")) return false;
      if (!isNonEmpty(r.userId || "")) return false;
      if (!isNonEmpty(r.rawText || "")) return false;
      return true;
    }
  },
  {
    sheetName: "sessions",
    fields: [
      { key: "sessionId", aliases: ["sessionId", "session_id"], legacyIndex: 0 },
      { key: "userId", aliases: ["userId", "user_id"], legacyIndex: 1 },
      { key: "type", aliases: ["type"], legacyIndex: 2 },
      { key: "content", aliases: ["content"], legacyIndex: 3 },
      { key: "timestamp", aliases: ["timestamp"], legacyIndex: 4 },
      { key: "meta", aliases: ["meta"], legacyIndex: 5 }
    ],
    validate: (r: Partial<SessionsRow>) => {
      if (!idLooksLike(["session_"], r.sessionId || "")) return false;
      if (!isNonEmpty(r.userId || "")) return false;
      if (!isSessionType(r.type || "")) return false;
      if (!isIsoLike(r.timestamp || "")) return false;
      return true;
    }
  }
];

async function main() {
  const { apply, limit, sheet } = parseArgs(process.argv.slice(2));

  const selected = sheet
    ? schemas.filter(s => s.sheetName === sheet)
    : schemas;

  if (!selected.length) {
    throw new Error(`Unknown --sheet "${sheet}". expected one of: ${schemas.map(s => s.sheetName).join(", ")}`);
  }

  for (const schema of selected) {
    await repairSheet(schema, apply, limit);
  }
}

main().catch(err => {
  console.error("[repair-sheets-misalignment] failed:", err?.message || err);
  process.exit(1);
});

