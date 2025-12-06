import type { NextApiRequest, NextApiResponse } from "next";
import { getSheetValues } from "../lib/sheets";
import { callDeepSeek } from "../lib/deepseek";
import { pushText } from "../lib/line";
import { SYSTEM_PROMPT } from "../lib/prompts";

function pickTodoTask(rows: string[][]) {
  return rows.find(row => (row[3] || "").toLowerCase() === "todo");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    return res.status(500).json({ message: "LINE_USER_ID is not set" });
  }

  const tasks = await getSheetValues("tasks");
  const todo = pickTodoTask(tasks.slice(1));
  const fallback = "今日は何もしない日。ログだけ残せ。";
  const candidate = todo?.[2] || fallback;

  const prompt = `ユーザーの今日のタスク案: ${candidate}\n短く命令文にして返して`;

  let aiText = candidate;
  try {
    const result = await callDeepSeek(SYSTEM_PROMPT, prompt);
    aiText = result || candidate;
  } catch (error) {
    console.error("DeepSeek/morning", error);
  }

  await pushText(userId, `【今日の最優先】\n${aiText.trim()}`);

  return res.status(200).json({ ok: true });
}
