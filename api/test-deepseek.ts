import axios from "axios";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY" });
    }

    await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: "You are a test bot." },
          { role: "user", content: "Hello. Respond with only OK" }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).send("OK");
  } catch (error) {
    const axiosError: any = error;
    const detail = axiosError?.response?.data || axiosError?.message || "Unknown error";

    res.status(500).json({ error: "DeepSeek API request failed", detail });
  }
}
