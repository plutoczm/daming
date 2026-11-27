/**
 * 顶层组合治理演示（P0）：一个用户持 6 个项目，展示组合级收件箱如何“少打扰”。
 * 纯离线、无网络、无副作用。运行：node scripts/demo-portfolio-governance.mjs
 */
import { buildPortfolioDigest, defaultAutonomyProfile } from '../apps/server/src/portfolio-governance.ts';

const NOW = Date.parse('2026-11-21T09:00:00+08:00');

const projects = [
  { projectId: 'p1', name: '官网改版', goal: '上线新版官网', accepted: false,
    pendingDecisions: [], blockers: [], stalledMinutes: 0, consecutiveFailures: 0,
    budget: null, evidencePassed: false, lastActivityAt: '2026-11-21T08:30:00+08:00' },
  { projectId: 'p2', name: '支付对账', goal: '完成对账模块', accepted: false,
    pendingDecisions: [{ decisionId: 'c2', kind: 'proposal', question: '把验收标准从「日清」改为「周清」？' }],
    blockers: [], stalledMinutes: 0, consecutiveFailures: 0, budget: null, evidencePassed: false,
    lastActivityAt: '2026-11-21T08:40:00+08:00' },
  { projectId: 'p3', name: '数据迁移', goal: '迁移历史库', accepted: false,
    pendingDecisions: [], blockers: [], stalledMinutes: 0, consecutiveFailures: 0,
    budget: { spentMinor: 620, capMinor: 500, unknown: true }, evidencePassed: false,
    lastActivityAt: '2026-11-21T08:45:00+08:00' },
  { projectId: 'p4', name: '报表导出', goal: '导出 Excel', accepted: false,
    pendingDecisions: [{ decisionId: 'a4', kind: 'acceptance', question: '验收导出结果？' }],
    blockers: [], stalledMinutes: 0, consecutiveFailures: 0, budget: null, evidencePassed: true,
    lastActivityAt: '2026-11-21T08:50:00+08:00' },
  { projectId: 'p5', name: '爬虫抓取', goal: '抓取商品价', accepted: false,
    pendingDecisions: [], blockers: [], stalledMinutes: 0, consecutiveFailures: 3,
    budget: null, evidencePassed: false, lastActivityAt: '2026-11-21T08:55:00+08:00' },
  { projectId: 'p6', name: '移动端适配', goal: '适配手机', accepted: false,
    pendingDecisions: [], blockers: [
      { id: '设计师未给切图', severity: 'medium' },
      { id: '接口鉴权未就绪', severity: 'medium' },
      { id: '测试环境宕机', severity: 'medium' },
    ], stalledMinutes: 0, consecutiveFailures: 0, budget: null, evidencePassed: false,
    lastActivityAt: '2026-11-21T08:58:00+08:00' },
];

const profiles = Object.fromEntries(projects.map(project => [project.projectId, defaultAutonomyProfile(project.projectId)]));

const digest = buildPortfolioDigest({ projects, profiles, now: NOW });

console.log('== 组合收件箱 · ' + digest.dayKey + ' ==');
console.log('项目总数 ' + digest.totals.projects + '｜需拍板 ' + digest.totals.needsYou +
  '｜风险 ' + digest.totals.atRisk + '｜待验收 ' + digest.totals.awaitingAcceptance +
  '｜健康 ' + digest.totals.healthy);
for (const [title, list] of [['【实时推送·生命线】', digest.realtime], ['【并入 digest·晨间汇总】', digest.digest]]) {
  console.log('\n' + title + ' (' + list.length + ')');
  for (const item of list) {
    console.log(' - [' + item.bucket + '/' + item.severity + '] ' + item.projectName + '：' + item.summary);
    console.log('     推荐：' + item.recommendation);
    console.log('     影响：' + item.impact + '｜超时默认：' + item.defaultAction);
  }
}
console.log('\n系统自动处理（不烦人）：');
for (const line of digest.autoHandled.length ? digest.autoHandled : ['（无）']) console.log(' - ' + line);
console.log('\n降噪说明：');
for (const line of digest.notes.length ? digest.notes : ['（无）']) console.log(' - ' + line);
