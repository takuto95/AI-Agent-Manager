import { NextResponse } from "next/server";
import { createSheetsStorage } from "../../../lib/storage/sheets-repository";

export const runtime = "nodejs";

const DAYS_RANGE = 3;
const MAX_ROWS = 20;

const storage = createSheetsStorage();

export async function GET() {
  const logs = await storage.logs.listRecent(DAYS_RANGE, MAX_ROWS);
  return NextResponse.json({ data: logs });
}
