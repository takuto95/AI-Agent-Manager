import axios from "axios";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

type DeepSeekContentPart =
  | string
  | {
      type?: string;
      text?: string;
      content?: string | DeepSeekContentPart[];
    };

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string | DeepSeekContentPart | DeepSeekContentPart[];
      thinking?: string;
    };
  }>;
};

export type DeepSeekMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function extractText(content: unknown): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(part => extractText(part))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (typeof content === "object") {
    const maybe = (content as { text?: unknown; content?: unknown }).text ?? (content as { text?: unknown; content?: unknown }).content;
    return extractText(maybe);
  }

  return "";
}

export async function callDeepSeek(systemPrompt: string, userText: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }

  const messages: DeepSeekMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText }
  ];

  const res = await axios.post<DeepSeekResponse>(
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

  const message = res.data.choices?.[0]?.message;
  const content = extractText(message?.content);
  const reasoning = typeof message?.thinking === "string" ? message.thinking.trim() : "";
  return content || reasoning;
}
