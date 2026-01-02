/**
 * LINEリッチメニュー設定
 * 
 * リッチメニューは、LINEトーク画面の下部に常時表示されるメニューです。
 * ユーザーがLINEを開いた瞬間にアクセスできるため、UX向上に効果的です。
 */

export const RICH_MENU_CONFIG = {
  size: {
    width: 2500,
    height: 1686 // 6ボタンレイアウト（2行3列）
  },
  selected: true, // デフォルトで表示
  name: 'TaskFlow メニュー v1',
  chatBarText: 'メニュー',
  areas: [
    // 1行目
    // 左: 今日のタスク
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: {
        type: 'message' as const,
        text: '#今日のタスク'
      }
    },
    // 中央: タスク一覧
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: {
        type: 'uri' as const,
        uri: 'https://liff.line.me/YOUR_LIFF_ID' // デプロイ後に置き換える
      }
    },
    // 右: 完了報告
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: {
        type: 'message' as const,
        text: '完了'
      }
    },
    
    // 2行目
    // 左: ステータス
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: {
        type: 'message' as const,
        text: '#ステータス'
      }
    },
    // 中央: 思考ログ
    {
      bounds: { x: 833, y: 843, width: 834, height: 843 },
      action: {
        type: 'message' as const,
        text: '#整理開始'
      }
    },
    // 右: ヘルプ
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: {
        type: 'message' as const,
        text: '?'
      }
    }
  ]
} as const;

/**
 * リッチメニュー用の画像仕様
 * 
 * - サイズ: 2500x1686px
 * - フォーマット: PNG/JPEG
 * - 最大ファイルサイズ: 1MB
 * - レイアウト: 2行3列（6ボタン）
 * 
 * 各ボタンのサイズ:
 * - 幅: 833px（左・右）、834px（中央）
 * - 高さ: 843px
 */

/**
 * リッチメニューのテキストラベル（画像に描画する）
 * 
 * 1行目:
 * [🎯 今日のタスク] [📋 タスク一覧] [✅ 完了報告]
 * 
 * 2行目:
 * [📊 ステータス] [💭 思考ログ] [❓ ヘルプ]
 */
export const RICH_MENU_LABELS = {
  todayTask: '🎯 今日のタスク',
  taskList: '📋 タスク一覧',
  complete: '✅ 完了報告',
  status: '📊 ステータス',
  thoughtLog: '💭 思考ログ',
  help: '❓ ヘルプ'
} as const;

/**
 * シンプル版リッチメニュー（4ボタン）
 * 
 * より重要な機能だけに絞った軽量版
 */
export const RICH_MENU_CONFIG_SIMPLE = {
  size: {
    width: 2500,
    height: 843 // 1行4列レイアウト
  },
  selected: true,
  name: 'TaskFlow メニュー シンプル',
  chatBarText: 'メニュー',
  areas: [
    // 今日のタスク
    {
      bounds: { x: 0, y: 0, width: 625, height: 843 },
      action: {
        type: 'message' as const,
        text: '#今日のタスク'
      }
    },
    // タスク一覧
    {
      bounds: { x: 625, y: 0, width: 625, height: 843 },
      action: {
        type: 'uri' as const,
        uri: 'https://liff.line.me/YOUR_LIFF_ID'
      }
    },
    // 完了報告
    {
      bounds: { x: 1250, y: 0, width: 625, height: 843 },
      action: {
        type: 'message' as const,
        text: '完了'
      }
    },
    // ステータス
    {
      bounds: { x: 1875, y: 0, width: 625, height: 843 },
      action: {
        type: 'message' as const,
        text: '#ステータス'
      }
    }
  ]
} as const;
