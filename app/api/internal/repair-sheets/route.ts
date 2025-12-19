import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "../../../../lib/security/internal-auth";
import { repairSheets } from "../../../../lib/tools/repair-sheets-misalignment";

export const runtime = "nodejs";

type Body = {
  apply?: boolean;
  sheet?: string;
  limit?: number;
};

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampLimit(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1000;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

export async function POST(req: Request) {
  const auth = authorizeInternalRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const raw = await req.text();
  const parsed = (parseJsonSafely(raw) || {}) as Body;
  const apply = Boolean(parsed.apply);
  const sheet = (parsed.sheet || "").trim() || undefined;
  const limit = clampLimit(parsed.limit);

  // Safety: do not allow unbounded apply in serverless runtime.
  const summaries = await repairSheets({ apply, sheet, limit });
  return NextResponse.json({ ok: true, apply, sheet: sheet ?? null, limit, summaries });
}

export async function GET(req: Request) {
  const auth = authorizeInternalRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const sheet = (url.searchParams.get("sheet") || "").trim() || undefined;
  const limit = clampLimit(url.searchParams.get("limit"));

  const summaries = await repairSheets({ apply: false, sheet, limit });
  return NextResponse.json({ ok: true, apply: false, sheet: sheet ?? null, limit, summaries });
}

