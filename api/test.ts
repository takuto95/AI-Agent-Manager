import axios from "axios";

export default async function handler(req, res) {
  const text = req.query?.text || "こんにちは";

  const result = await axios.post(
    "https://api.deepseek.com/v1/chat/completions",
    {
      model: "deepseek-reasoner",
      messages: [
        { role: "system", content: "あなたはテスト用AIです。" },
        { role: "user", content: text }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  res.status(200).json(result.data);
}
