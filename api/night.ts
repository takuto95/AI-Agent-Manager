import type { NextApiRequest, NextApiResponse } from "next";
import { pushText } from "../lib/line";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    return res.status(500).json({ message: "LINE_USER_ID is not set" });
  }

  await pushText(
    userId,
    "【確認】今日の命令は実行したか？\n✅ 完了 / ❌ 未達\n理由を1行で返信してください。"
  );

  return res.status(200).json({ ok: true });
}
