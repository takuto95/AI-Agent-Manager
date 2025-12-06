import axios from "axios";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

type DeepSeekMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function callDeepSeek(systemPrompt: string, userText: string) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }

  const messages: DeepSeekMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText }
  ];

  try {
    const res = await axios.post(
      DEEPSEEK_URL,
      {
        model: "deepseek-reasoner",
        messages,
        max_tokens: 800
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    console.error("DeepSeek API call failed", error);
    throw new Error("Failed to call DeepSeek API");
  }
}
