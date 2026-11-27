import { useState } from 'react';
import type { MagpieOperationView } from '@daming/contracts';

const STATUS: Record<MagpieOperationView['status'], string> = {
  prepared: '待执行批准', executing: '执行中', succeeded: '已确认完成',
  partial: '部分完成', failed: '失败', no_accounts: '无可签到账号', needs_attention: '需要人工处理', unknown: '结果未知，禁止自动重试',
  expired: '授权已过期', cancelled: 'Windows 确认已拒绝', reconciled: '已人工核对'
};
const ACTION: Record<string, string> = {
  'plugin-add': '安装插件', 'plugin-update': '更新插件', 'plugin-toggle': '插件启停',
  'plugin-check': '检查插件更新', 'refresh-quotas': '刷新额度',
  'workbuddy-checkin': 'WorkBuddy 签到'
};

export function MagpieOperations({
  operations, canWrite, onReconcile
}: {
  readonly operations: readonly MagpieOperationView[];
  readonly canWrite: boolean;
  readonly onReconcile: (id: string, resolution: 'succeeded' | 'not_executed') => Promise<void>;
}) {
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const attention = operations.filter((op) =>
    ['unknown', 'needs_attention', 'partial', 'failed'].includes(op.status)
  );
  const filtered = onlyAttention ? attention : operations;
  return (
    <section className="magpie-receipts" aria-label="操作审计回执">
      <strong>最近操作回执</strong>
      <p className="magpie-explainer">本地持久化记录，不包含账号、密钥或插件运行输出。未知结果不会自动重试。</p>
      <div className="magpie-receipt-filters" role="group" aria-label="操作回执筛选">
        <button type="button" aria-pressed={!onlyAttention} onClick={() => { setOnlyAttention(false); setShowAll(false); }}>全部 {operations.length}</button>
        <button type="button" aria-pressed={onlyAttention} onClick={() => { setOnlyAttention(true); setShowAll(false); }}>需要关注 {attention.length}</button>
      </div>
      {!filtered.length && <p className="magpie-empty">{onlyAttention ? '暂无需要关注的操作' : '还没有经过大铭授权流程的操作。'}</p>}
      {(showAll ? filtered : filtered.slice(0, 8)).map((op) => (
        <div className="magpie-record" key={op.id}>
          <div className="magpie-record-head">
            <strong>{ACTION[op.action] ?? op.action}{op.target ? ' · ' + op.target : ''}</strong>
            <span>{STATUS[op.status]}</span>
          </div>
          <p><time dateTime={op.requestedAt}>{new Date(op.requestedAt).toLocaleString()}</time> · {op.id.slice(0, 8)} · {op.risk === 'high' ? '高风险／Windows 二次确认' : '中风险／限时授权'}</p>
          {op.checkin && <p>
            {op.checkin.total} 个结果：领取 {op.checkin.claimed}、已签到 {op.checkin.already}、
            验证码/需在官方 App 操作 {op.checkin.captcha}、失败 {op.checkin.failed}、
            其他 {op.checkin.other}
            {op.checkin.creditsReported > 0 ? ' · 报告积分 ' + op.checkin.creditsReported : ''}
          </p>}
          {op.status === 'unknown' && <p role="alert">请先在对应服务核对实际效果。未核对前，相同操作会被阻止。</p>}
          {op.status === 'needs_attention' && <p>如遇验证码，请在对应服务的官方页面处理，任务板不会自动重试签到。</p>}
          {op.status === 'reconciled' && <p>人工认定：{op.resolution === 'succeeded' ? '已执行' : '未执行'}</p>}
          {canWrite && op.status === 'unknown' && (
            <div className="magpie-action-row">
              <button type="button" onClick={() => void onReconcile(op.id, 'succeeded')}>已确认执行</button>
              <button type="button" onClick={() => void onReconcile(op.id, 'not_executed')}>已确认未执行</button>
            </div>
          )}
        </div>
      ))}
      {filtered.length > 8 && (
        <button type="button" className="magpie-expand-receipts" onClick={() => setShowAll((value) => !value)}>
          {showAll ? '收起记录' : `查看全部 ${filtered.length} 条记录`}
        </button>
      )}
    </section>
  );
}
