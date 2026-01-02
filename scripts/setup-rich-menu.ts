/**
 * LINEリッチメニュー登録スクリプト
 * 
 * 使い方:
 * 1. リッチメニュー画像を準備（2500x1686px、PNG/JPEG）
 * 2. 画像を public/rich-menu.png に配置
 * 3. このスクリプトを実行: npm run setup-rich-menu
 * 4. 生成されたリッチメニューIDを環境変数に設定（オプション）
 */

import * as line from '@line/bot-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { RICH_MENU_CONFIG, RICH_MENU_CONFIG_SIMPLE } from '../lib/line/rich-menu-config';

// 環境変数チェック
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!channelAccessToken) {
  console.error('❌ LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
  process.exit(1);
}

const client = new line.Client({
  channelAccessToken,
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
});

/**
 * リッチメニューを作成
 */
async function createRichMenu(config: typeof RICH_MENU_CONFIG | typeof RICH_MENU_CONFIG_SIMPLE) {
  try {
    console.log('📝 リッチメニューを作成中...');
    
    const richMenu = await client.createRichMenu({
      size: config.size,
      selected: config.selected,
      name: config.name,
      chatBarText: config.chatBarText,
      areas: config.areas as any
    });

    console.log('✅ リッチメニュー作成成功！');
    console.log(`   リッチメニューID: ${richMenu.richMenuId}`);
    
    return richMenu.richMenuId;
  } catch (error: any) {
    console.error('❌ リッチメニュー作成失敗:', error.message);
    throw error;
  }
}

/**
 * リッチメニュー画像をアップロード
 */
async function uploadRichMenuImage(richMenuId: string, imagePath: string) {
  try {
    console.log('🖼️  画像をアップロード中...');
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`画像ファイルが見つかりません: ${imagePath}`);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    
    await client.setRichMenuImage(richMenuId, imageBuffer, 'image/png');
    
    console.log('✅ 画像アップロード成功！');
  } catch (error: any) {
    console.error('❌ 画像アップロード失敗:', error.message);
    throw error;
  }
}

/**
 * デフォルトリッチメニューに設定
 */
async function setDefaultRichMenu(richMenuId: string) {
  try {
    console.log('⚙️  デフォルトリッチメニューに設定中...');
    
    await client.setDefaultRichMenu(richMenuId);
    
    console.log('✅ デフォルト設定成功！');
    console.log('   すべてのユーザーにこのリッチメニューが表示されます。');
  } catch (error: any) {
    console.error('❌ デフォルト設定失敗:', error.message);
    throw error;
  }
}

/**
 * 既存のリッチメニューを削除
 */
async function deleteExistingRichMenus() {
  try {
    console.log('🗑️  既存のリッチメニューを確認中...');
    
    const richMenus = await client.getRichMenuList();
    
    if (richMenus.length === 0) {
      console.log('   既存のリッチメニューはありません。');
      return;
    }

    console.log(`   既存のリッチメニュー: ${richMenus.length}件`);
    
    for (const menu of richMenus) {
      console.log(`   削除中: ${menu.richMenuId} (${menu.name})`);
      await client.deleteRichMenu(menu.richMenuId);
    }
    
    console.log('✅ 既存のリッチメニューを削除しました。');
  } catch (error: any) {
    console.error('⚠️  既存メニュー削除でエラー:', error.message);
    // 削除失敗は続行可能
  }
}

/**
 * リッチメニュー一覧を表示
 */
async function listRichMenus() {
  try {
    const richMenus = await client.getRichMenuList();
    
    console.log('\n📋 現在のリッチメニュー一覧:');
    
    if (richMenus.length === 0) {
      console.log('   （なし）');
      return;
    }

    for (const menu of richMenus) {
      console.log(`\n   ID: ${menu.richMenuId}`);
      console.log(`   名前: ${menu.name}`);
      console.log(`   サイズ: ${menu.size.width}x${menu.size.height}`);
      console.log(`   ボタン数: ${menu.areas.length}`);
    }

    // デフォルトメニューを確認
    try {
      const defaultMenuId = await client.getDefaultRichMenuId();
      console.log(`\n   ⭐ デフォルト: ${defaultMenuId}`);
    } catch {
      console.log('\n   ⭐ デフォルト: 未設定');
    }
  } catch (error: any) {
    console.error('❌ 一覧取得失敗:', error.message);
  }
}

/**
 * メイン処理
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'setup';

  console.log('🚀 LINEリッチメニュー管理');
  console.log('='.repeat(50));

  try {
    if (command === 'list') {
      // 一覧表示
      await listRichMenus();
      return;
    }

    if (command === 'delete') {
      // 削除のみ
      await deleteExistingRichMenus();
      return;
    }

    if (command === 'setup' || command === 'create') {
      // 新規作成
      const useSimple = args.includes('--simple');
      const skipImage = args.includes('--skip-image');
      const skipDefault = args.includes('--skip-default');
      const deleteExisting = args.includes('--delete-existing');

      if (deleteExisting) {
        await deleteExistingRichMenus();
      }

      const config = useSimple ? RICH_MENU_CONFIG_SIMPLE : RICH_MENU_CONFIG;
      const richMenuId = await createRichMenu(config);

      if (!skipImage) {
        const imagePath = path.join(process.cwd(), 'public', 'rich-menu.png');
        await uploadRichMenuImage(richMenuId, imagePath);
      }

      if (!skipDefault) {
        await setDefaultRichMenu(richMenuId);
      }

      console.log('\n' + '='.repeat(50));
      console.log('✨ セットアップ完了！');
      console.log(`\n📝 リッチメニューID: ${richMenuId}`);
      console.log('\n💡 次のステップ:');
      console.log('   1. LINEアプリでトーク画面を確認');
      console.log('   2. メニューボタンをタップして動作確認');
      console.log('   3. LIFFのURLを設定（タスク一覧ボタン用）');
      
      return;
    }

    console.error(`❌ 不明なコマンド: ${command}`);
    console.log('\n使い方:');
    console.log('  npm run setup-rich-menu              # リッチメニューを作成');
    console.log('  npm run setup-rich-menu -- list      # 一覧表示');
    console.log('  npm run setup-rich-menu -- delete    # 削除');
    console.log('\nオプション:');
    console.log('  --simple            # シンプル版（4ボタン）を使用');
    console.log('  --skip-image        # 画像アップロードをスキップ');
    console.log('  --skip-default      # デフォルト設定をスキップ');
    console.log('  --delete-existing   # 既存のメニューを削除してから作成');

  } catch (error) {
    console.error('\n💥 エラーが発生しました');
    process.exit(1);
  }
}

// 実行
if (require.main === module) {
  main();
}
