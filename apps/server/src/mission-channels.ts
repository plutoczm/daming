import type { MissionNotificationPreviewView, MissionView } from '@daming/contracts';

/** Outbound-only presentation intent. Not a Feishu webhook, sender or callback handler. */
export function previewMissionNotification(mission: MissionView): MissionNotificationPreviewView {
  return {
    missionId: mission.missionId, version: 1, cardId: mission.cardId,
    title: '大铭：需要你的决定',
    // Never include goals, raw model outputs, account IDs or access tokens in chat cards.
    text: mission.cardId === null
      ? '任务正在等待生成本机审核卡。'
      : '一个离线演示任务已暂停，等待授权。请打开经过认证的大铭控制台作出决定。',
    actions: [
      { choice: 0, label: '批准（须在大铭完成认证）' },
      { choice: 1, label: '拒绝（须在大铭完成认证）' }
    ],
    channels: [
      { id: 'feishu', interactive: true, configured: false, sent: false },
      { id: 'wecom', interactive: false, configured: false, sent: false },
      { id: 'wechat', interactive: false, configured: false, sent: false },
      { id: 'qq', interactive: false, configured: false, sent: false }
    ],
    requiresVerifiedUserIdentity: true, requiresSignedCallback: true, sent: false
  };
}
