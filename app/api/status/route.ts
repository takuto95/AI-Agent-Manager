import { NextRequest, NextResponse } from "next/server";
import { createSheetsStorage } from "../../../lib/storage/sheets-repository";
import { SessionRepository } from "../../../lib/storage/session-repository";
import { getUserStatus, formatStatusInfo } from "../../../lib/core/status-service";

/**
 * GET /api/status
 * ユーザーの現在のステータス（設定、タスク、ゴール進捗）を取得
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || process.env.LINE_USER_ID || "";
    const format = searchParams.get("format") || "text"; // text | json

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const storage = createSheetsStorage();
    const sessionRepo = new SessionRepository();

    const statusInfo = await getUserStatus(userId, storage, sessionRepo);

    if (format === "json") {
      return NextResponse.json({
        success: true,
        data: statusInfo
      });
    }

    // デフォルトはテキスト形式
    const formatted = formatStatusInfo(statusInfo);
    return NextResponse.json({
      success: true,
      text: formatted,
      data: statusInfo
    });
  } catch (error) {
    console.error("[GET /api/status] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to get status",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
