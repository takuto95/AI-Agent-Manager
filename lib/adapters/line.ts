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

export async function replyTexts(replyToken: string, texts: string[]) {
  if (!replyToken || !texts.length) return;
  const messages = texts.slice(0, 5).map(text => ({ type: "text" as const, text }));
  await getClient().replyMessage(replyToken, messages);
}

type QuickReplyButton =
  | { label: string; text: string }
  | { label: string; uri: string };

function buildQuickReplyItems(buttons: QuickReplyButton[]): line.QuickReplyItem[] {
  return buttons.map(btn => {
    if ("uri" in btn) {
      return {
        type: "action",
        action: { type: "uri", label: btn.label, uri: btn.uri }
      } satisfies line.QuickReplyItem;
    }
    return {
      type: "action",
      action: { type: "message", label: btn.label, text: btn.text }
    } satisfies line.QuickReplyItem;
  });
}

export async function replyTextWithQuickReply(
  replyToken: string,
  text: string,
  buttons: QuickReplyButton[]
) {
  if (!replyToken) return;
  await getClient().replyMessage(replyToken, {
    type: "text",
    text,
    quickReply: { items: buildQuickReplyItems(buttons) }
  });
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

export async function pushFlexMessage(userId: string, altText: string, contents: line.FlexContainer) {
  if (!userId) {
    throw new Error("LINE_USER_ID is not set");
  }
  await getClient().pushMessage(userId, {
    type: "flex",
    altText,
    contents
  });
}

export async function replyFlexMessage(replyToken: string, altText: string, contents: line.FlexContainer) {
  if (!replyToken) return;
  await getClient().replyMessage(replyToken, {
    type: "flex",
    altText,
    contents
  });
}

export async function replyMessages(replyToken: string, messages: line.Message[]) {
  if (!replyToken || !messages.length) return;
  await getClient().replyMessage(replyToken, messages.slice(0, 5));
}
