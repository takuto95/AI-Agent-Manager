import * as line from "@line/bot-sdk";

/**
 * 朝の命令用Flexメッセージを生成
 * 
 * @param params タスク情報とAI選定結果
 * @returns Flex Message（Bubble形式）
 */
export function buildMorningTaskFlexMessage(params: {
  task: {
    id: string;
    description: string;
    priority?: string;
    dueDate?: string;
    goalTitle?: string;
  };
  aiReason?: string;
  contextSuggestion?: string;
  aiUsed: boolean;
}): line.FlexBubble {
  const { task, aiReason, contextSuggestion, aiUsed } = params;
  
  // 優先度に応じた色設定
  const priorityColor = 
    task.priority === 'A' ? '#FF6B6B' :
    task.priority === 'B' ? '#FFA500' :
    task.priority === 'C' ? '#4ECDC4' :
    '#999999';
  
  // 期限の表示（3日以内なら強調）
  const dueDateText = task.dueDate || 'なし';
  const isDueSoon = task.dueDate && isWithinDays(task.dueDate, 3);
  const dueDateColor = isDueSoon ? '#FF6B6B' : '#666666';
  
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '🎯 今日の焦点',
          weight: 'bold',
          color: '#1DB446',
          size: 'md'
        }
      ],
      backgroundColor: '#F0FFF0',
      paddingAll: 'md'
    },
    hero: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: task.description,
          weight: 'bold',
          size: 'xl',
          wrap: true,
          color: '#2C3E50'
        }
      ],
      backgroundColor: '#FFFFFF',
      paddingAll: 'xl'
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        // ゴール表示
        ...(task.goalTitle ? [{
          type: 'box' as const,
          layout: 'baseline' as const,
          contents: [
            { type: 'text' as const, text: '🎯', size: 'sm' as const, flex: 0 },
            { 
              type: 'text' as const, 
              text: task.goalTitle, 
              size: 'sm' as const, 
              color: '#666666', 
              flex: 1,
              margin: 'sm' as const,
              wrap: true
            }
          ],
          margin: 'md' as const
        }] : []),
        
        // 優先度・期限
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              contents: [
                { type: 'text', text: '優先度:', size: 'sm', color: '#999999', flex: 0 },
                { 
                  type: 'text', 
                  text: task.priority || '-', 
                  size: 'sm', 
                  color: priorityColor,
                  weight: 'bold',
                  margin: 'sm',
                  flex: 0
                }
              ],
              flex: 1
            },
            {
              type: 'box',
              layout: 'baseline',
              contents: [
                { type: 'text', text: '期限:', size: 'sm', color: '#999999', flex: 0 },
                { 
                  type: 'text', 
                  text: dueDateText, 
                  size: 'sm', 
                  color: dueDateColor,
                  weight: isDueSoon ? 'bold' : 'regular',
                  margin: 'sm',
                  flex: 0
                }
              ],
              flex: 1
            }
          ],
          margin: 'md'
        },
        
        // AI選定理由
        ...(aiUsed && aiReason ? [{
          type: 'box' as const,
          layout: 'vertical' as const,
          contents: [
            {
              type: 'text' as const,
              text: '💡 AI選定理由',
              size: 'xs' as const,
              color: '#999999',
              weight: 'bold' as const
            },
            {
              type: 'text' as const,
              text: aiReason,
              size: 'xs' as const,
              color: '#666666',
              wrap: true,
              margin: 'xs' as const
            }
          ],
          margin: 'lg' as const,
          backgroundColor: '#F8F9FA',
          paddingAll: 'sm' as const,
          cornerRadius: 'md' as const
        }] : []),
        
        // 今日の傾向（行動パターン分析）
        ...(contextSuggestion ? [{
          type: 'box' as const,
          layout: 'vertical' as const,
          contents: [
            {
              type: 'text' as const,
              text: '📊 今日の傾向',
              size: 'xs' as const,
              color: '#999999',
              weight: 'bold' as const
            },
            {
              type: 'text' as const,
              text: contextSuggestion,
              size: 'xs' as const,
              color: '#666666',
              wrap: true,
              margin: 'xs' as const
            }
          ],
          margin: 'lg' as const,
          backgroundColor: '#FFF8E1',
          paddingAll: 'sm' as const,
          cornerRadius: 'md' as const
        }] : [])
      ],
      paddingAll: 'xl'
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        // メインボタン: 今すぐ開始
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          action: {
            type: 'postback',
            label: '✅ 今すぐ開始',
            data: `action=start_task&taskId=${task.id}`,
            displayText: '✅ このタスクに取り組みます'
          },
          color: '#1DB446'
        },
        // サブボタン群（横並び）
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'postback',
                label: '⏰ 後で',
                data: `action=snooze_task&taskId=${task.id}`,
                displayText: '⏰ 後でやります'
              },
              flex: 1
            },
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'postback',
                label: '🔄 変更',
                data: 'action=change_task',
                displayText: '変更'
              },
              flex: 1
            }
          ]
        }
      ],
      paddingAll: 'xl'
    }
  };
}

/**
 * タスク開始確認メッセージ（クイックリプライ付き）
 */
export function buildTaskStartedMessage(params: {
  taskDescription: string;
}): line.Message[] {
  return [
    {
      type: 'text',
      text: `✅ 了解！「${params.taskDescription}」に取り組み中。\n\n集中して頑張ろう。完了したら「完了」と送ってね。`,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'message',
              label: '✅ 完了報告',
              text: '完了'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '⏱️ 25分タイマー',
              data: 'action=set_timer&minutes=25',
              displayText: '⏱️ 25分タイマーをセット'
            }
          }
        ]
      }
    }
  ];
}

/**
 * スヌーズ確認メッセージ（クイックリプライ付き）
 */
export function buildSnoozeMessage(): line.Message {
  return {
    type: 'text',
    text: '⏰ 了解。1時間後にもう一度お知らせするね。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '30分後',
            text: '#リマインド 30分'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '2時間後',
            text: '#リマインド 2時間'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '今すぐ開始',
            text: '#今日のタスク'
          }
        }
      ]
    }
  };
}

/**
 * 日付が指定日数以内かチェック
 */
function isWithinDays(dateString: string, days: number): boolean {
  try {
    const targetDate = new Date(dateString);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays >= 0 && diffDays <= days;
  } catch {
    return false;
  }
}
