import axios from "axios";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

export type DeepSeekMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function callDeepSeek(systemPrompt: string, userText: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }

  const messages: DeepSeekMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText }
  ];

  const res = await axios.post(
    DEEPSEEK_URL,
    {
      model: "deepseek-reasoner",
      messages,
      max_tokens: 800
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices?.[0]?.message?.content?.trim() ?? "";
}
