import * as line from "@line/bot-sdk";

let client: line.Client | null = null;

function getClient() {
  if (client) {
    return client;
  }

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken || !channelSecret) {
    throw new Error("LINE credentials are not set");
  }

  client = new line.Client({ channelAccessToken, channelSecret });
  return client;
}

export async function replyText(replyToken: string, text: string) {
  if (!replyToken) return;
  await getClient().replyMessage(replyToken, { type: "text", text });
}

export async function pushText(userId: string, text: string) {
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }
  await getClient().pushMessage(userId, { type: "text", text });
}

export async function pushTemplate(userId: string, template: line.TemplateMessage) {
  await getClient().pushMessage(userId, template);
}
