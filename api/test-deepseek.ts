const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

const payload = {
  model: "deepseek-reasoner",
  messages: [
    { role: "system", content: "You are a test bot." },
    { role: "user", content: "Hello. Respond with only: OK" }
  ]
};

export default async function handler(req, res) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      success: false,
      error: "Missing DEEPSEEK_API_KEY environment variable."
    });
    return;
  }

  try {
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseBody: any = null;

    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // keep responseBody as null when JSON parsing fails
    }

    if (!response.ok) {
      res.status(500).json({
        success: false,
        error: "DeepSeek API request failed.",
        details: responseBody ?? responseText
      });
      return;
    }

    const reply =
      responseBody?.choices?.[0]?.message?.content?.trim?.() ?? "OK";

    res.status(200).json({ success: true, reply });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message ?? "Unknown error"
    });
  }
}
