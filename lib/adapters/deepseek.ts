import axios from "axios";
import crypto from "crypto";

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

type AxiosMeta = { reqId: string; startedAt: number };

function isDeepSeekHttpLogEnabled(): boolean {
  return process.env.DEEPSEEK_HTTP_LOG === "1" || process.env.DEEPSEEK_HTTP_LOG === "true";
}

function isDeepSeekHttpBodyLogEnabled(): boolean {
  return process.env.DEEPSEEK_HTTP_LOG_BODY === "1" || process.env.DEEPSEEK_HTTP_LOG_BODY === "true";
}

function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const obj = headers as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "authorization") {
      out[key] = "[REDACTED]";
    }
  }
  return out;
}

function safeJsonStringify(value: unknown, maxLen = 4000): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…(truncated ${s.length - maxLen} chars)`;
}

function makeReqId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

const deepseekHttp = axios.create();

deepseekHttp.interceptors.request.use(config => {
  const meta: AxiosMeta = { reqId: makeReqId(), startedAt: Date.now() };
  (config as unknown as { metadata?: AxiosMeta }).metadata = meta;

  if (isDeepSeekHttpLogEnabled()) {
    const method = (config.method ?? "GET").toUpperCase();
    const url = config.url ?? "";
    const headers = redactHeaders(config.headers);
    const base = { reqId: meta.reqId, method, url };
    if (isDeepSeekHttpBodyLogEnabled()) {
      console.log("[deepseek][request]", base, headers, safeJsonStringify(config.data));
    } else {
      console.log("[deepseek][request]", base, headers);
    }
  }

  return config;
});

deepseekHttp.interceptors.response.use(
  res => {
    const meta = (res.config as unknown as { metadata?: AxiosMeta }).metadata;
    const elapsedMs = meta ? Date.now() - meta.startedAt : undefined;

    if (isDeepSeekHttpLogEnabled()) {
      const method = (res.config.method ?? "GET").toUpperCase();
      const url = res.config.url ?? "";
      const base = { reqId: meta?.reqId, method, url, status: res.status, elapsedMs };
      if (isDeepSeekHttpBodyLogEnabled()) {
        console.log("[deepseek][response]", base, safeJsonStringify(res.data));
      } else {
        console.log("[deepseek][response]", base);
      }
    }

    return res;
  },
  err => {
    const anyErr = err as {
      message?: string;
      code?: string;
      config?: unknown;
      response?: { status?: number; data?: unknown };
    };
    const cfg = anyErr.config as unknown as { url?: string; method?: string; metadata?: AxiosMeta } | undefined;
    const meta = cfg?.metadata;
    const elapsedMs = meta ? Date.now() - meta.startedAt : undefined;

    if (isDeepSeekHttpLogEnabled()) {
      const method = (cfg?.method ?? "GET").toUpperCase();
      const url = cfg?.url ?? "";
      const base = {
        reqId: meta?.reqId,
        method,
        url,
        status: anyErr?.response?.status,
        elapsedMs,
        code: anyErr?.code,
        message: anyErr?.message
      };
      if (isDeepSeekHttpBodyLogEnabled()) {
        console.error("[deepseek][error]", base, safeJsonStringify(anyErr?.response?.data));
      } else {
        console.error("[deepseek][error]", base);
      }
    }

    return Promise.reject(err);
  }
);

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

  const requestBody = {
    model: "deepseek-reasoner",
    messages,
    max_tokens: 800
  };

  const requestHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  const res = await deepseekHttp.post<DeepSeekResponse>(DEEPSEEK_URL, requestBody, { headers: requestHeaders });

  const message = res.data.choices?.[0]?.message;
  const content = extractText(message?.content);
  const reasoning = typeof message?.thinking === "string" ? message.thinking.trim() : "";
  return content || reasoning;
}
