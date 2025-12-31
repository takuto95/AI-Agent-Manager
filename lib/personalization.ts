import { CharacterRole, MessageTone, UserSettingsRecord } from "./storage/repositories";

/**
 * メッセージトーンの変換
 * strict: 厳格（「〜しろ」「〜だ」）
 * formal: 敬語（「〜してください」「〜です」）
 * friendly: フレンドリー（「〜しよう」「〜だね」）
 */
export function convertMessageTone(message: string, tone: MessageTone): string {
  if (tone === "strict") {
    // 現行のメッセージはすでにstrict
    return message;
  }
  
  if (tone === "formal") {
    // strict → formal
    return message
      .replace(/送れ\b/g, "送ってください")
      .replace(/しろ\b/g, "してください")
      .replace(/やれ\b/g, "やってください")
      .replace(/確認しろ\b/g, "確認してください")
      .replace(/作れ\b/g, "作ってください")
      .replace(/使え\b/g, "使ってください")
      .replace(/締めろ\b/g, "締めてください")
      .replace(/だ。/g, "です。")
      .replace(/だった。/g, "でした。")
      .replace(/だ\n/g, "です\n")
      .replace(/ない。/g, "ありません。");
  }
  
  if (tone === "friendly") {
    // strict → friendly
    return message
      .replace(/送れ\b/g, "送ろう")
      .replace(/しろ\b/g, "しよう")
      .replace(/やれ\b/g, "やろう")
      .replace(/確認しろ\b/g, "確認しよう")
      .replace(/作れ\b/g, "作ろう")
      .replace(/使え\b/g, "使おう")
      .replace(/締めろ\b/g, "締めよう")
      .replace(/だ。/g, "だね。")
      .replace(/だった。/g, "だったね。")
      .replace(/だ\n/g, "だね\n");
  }
  
  return message;
}

/**
 * キャラクターロールに応じた呼びかけ
 */
export function getCharacterPrefix(role: CharacterRole, displayName: string): string {
  if (displayName) {
    // カスタム名が設定されている場合はそれを使う
    return displayName;
  }
  
  switch (role) {
    case "ceo":
      return "社長";
    case "heir":
      return "若様";
    case "athlete":
      return "選手";
    case "scholar":
      return "博士";
    case "default":
    default:
      return "";
  }
}

/**
 * キャラクターロールに応じたメッセージのカスタマイズ
 */
export function customizeMessageForRole(message: string, role: CharacterRole, prefix: string): string {
  if (role === "default" || !prefix) {
    return message;
  }
  
  // 「今日の焦点」などをロールに応じて変更
  let customized = message;
  
  switch (role) {
    case "ceo":
      customized = customized
        .replace(/🎯 今日の焦点/g, `🎯 ${prefix}、今日の経営課題`)
        .replace(/おはよう/g, `${prefix}、おはようございます`)
        .replace(/今日もやっていこう/g, "今日も経営判断を下していきましょう");
      break;
    case "heir":
      customized = customized
        .replace(/🎯 今日の焦点/g, `🎯 ${prefix}、今日の修行`)
        .replace(/おはよう/g, `${prefix}、おはようございます`)
        .replace(/今日もやっていこう/g, "今日も将来の当主として成長しましょう");
      break;
    case "athlete":
      customized = customized
        .replace(/🎯 今日の焦点/g, `🎯 ${prefix}、今日のトレーニング`)
        .replace(/おはよう/g, `${prefix}、おはよう`)
        .replace(/今日もやっていこう/g, "今日も記録更新を目指そう");
      break;
    case "scholar":
      customized = customized
        .replace(/🎯 今日の焦点/g, `🎯 ${prefix}、今日の研究テーマ`)
        .replace(/おはよう/g, `${prefix}、おはようございます`)
        .replace(/今日もやっていこう/g, "今日も知的好奇心を満たしましょう");
      break;
  }
  
  return customized;
}

/**
 * メッセージをユーザー設定に応じてパーソナライズ
 */
export function personalizeMessage(message: string, settings: UserSettingsRecord): string {
  // 1. トーン変換
  let personalized = convertMessageTone(message, settings.messageTone);
  
  // 2. キャラクターロール対応
  const prefix = getCharacterPrefix(settings.characterRole, settings.displayName);
  personalized = customizeMessageForRole(personalized, settings.characterRole, prefix);
  
  return personalized;
}
