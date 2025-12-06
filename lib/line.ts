import * as line from "@line/bot-sdk";

function getClient() {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken || !channelSecret) {
    throw new Error("LINE channel credentials are not set");
  }

  return new line.Client({ channelAccessToken, channelSecret });
}

const client = getClient();

export async function replyText(replyToken: string, text: string) {
  await client.replyMessage(replyToken, { type: "text", text });
}

export async function pushText(userId: string, text: string) {
  await client.pushMessage(userId, { type: "text", text });
}

export async function pushConfirm(
  userId: string,
  title: string,
  yesPostback: string,
  noPostback: string
) {
  await client.pushMessage(userId, {
    type: "template",
    altText: title,
    template: {
      type: "buttons",
      title,
      text: "承認しますか？",
      actions: [
        { type: "postback", label: "承認", data: yesPostback },
        { type: "postback", label: "修正", data: noPostback }
      ]
    }
  });
}
