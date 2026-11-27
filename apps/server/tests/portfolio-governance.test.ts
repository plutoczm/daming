import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AutonomyProfileView, PortfolioProjectView } from '@daming/contracts';
import {
  PortfolioGovernance, PortfolioGovernanceStore, autoAcceptEligible, buildPortfolioDigest,
  collectEscalations, defaultAutonomyProfile,
} from '../src/portfolio-governance.ts';

const NOW = Date.parse('2026-11-21T02:00:00Z');

function project(overrides: Partial<PortfolioProjectView> = {}): PortfolioProjectView {
  return {
    projectId: 'p1', name: '项目一', goal: '交付', accepted: false,
    pendingDecisions: [], blockers: [], stalledMinutes: 0, consecutiveFailures: 0,
    budget: null, evidencePassed: false, lastActivityAt: '2026-11-21T01:00:00Z',
    ...overrides,
  };
}
function profile(overrides: Partial<AutonomyProfileView> = {}): AutonomyProfileView {
  return { ...defaultAutonomyProfile('p1'), ...overrides };
}

test('routine project stays healthy and never reaches the human (少管默认)', () => {
  const d = buildPortfolioDigest({ projects: [project()], profiles: { p1: profile() }, now: NOW });
  assert.equal(d.realtime.length, 0);
  assert.equal(d.digest.length, 0);
  assert.equal(d.totals.healthy, 1);
  assert.equal(defaultAutonomyProfile('x').mode, 'auto');
  assert.equal(defaultAutonomyProfile('x').maxInterruptsPerDay, 2);
});

test('contract change is a realtime lifeline with safe hold default', () => {
  const p = project({ pendingDecisions: [{ decisionId: 'c1', kind: 'proposal', question: '改验收标准' }] });
  const d = buildPortfolioDigest({ projects: [p], profiles: { p1: profile() }, now: NOW });
  const item = d.realtime.find(entry => entry.kind === 'contract');
  assert.ok(item);
  assert.equal(item!.severity, 'high');
  assert.equal(item!.bucket, 'needs_you');
  assert.equal(item!.defaultAction, 'hold');
});

test('acceptance is batched into digest, not a realtime interrupt', () => {
  const p = project({ pendingDecisions: [{ decisionId: 'a1', kind: 'acceptance', question: '验收交付？' }] });
  const d = buildPortfolioDigest({ projects: [p], profiles: { p1: profile() }, now: NOW });
  assert.equal(d.realtime.some(entry => entry.kind === 'acceptance'), false);
  assert.equal(d.digest.some(entry => entry.kind === 'acceptance'), true);
  assert.equal(d.totals.awaitingAcceptance, 1);
});

test('auto acceptance only when auto mode + evidence PASS + autoAccept', () => {
  const p = project({ pendingDecisions: [{ decisionId: 'a1', kind: 'acceptance', question: '验收？' }], evidencePassed: true });

  const auto = buildPortfolioDigest({ projects: [p], profiles: { p1: profile({ mode: 'auto', autoAccept: true }) }, now: NOW });
  assert.equal(auto.autoHandled.length, 1);
  assert.equal(auto.digest.some(entry => entry.kind === 'acceptance'), false); // 自动了，不烦人

  const supervised = buildPortfolioDigest({ projects: [p], profiles: { p1: profile({ mode: 'supervised' }) }, now: NOW });
  assert.equal(supervised.autoHandled.length, 0);
  assert.equal(supervised.digest.some(entry => entry.kind === 'acceptance'), true);

  const noEvidence = buildPortfolioDigest({ projects: [project({ pendingDecisions: p.pendingDecisions })], profiles: { p1: profile() }, now: NOW });
  assert.equal(noEvidence.autoHandled.length, 0); // 证据未 PASS 不自动（REQ-009）
  assert.equal(noEvidence.digest.some(entry => entry.kind === 'acceptance'), true);

  assert.equal(autoAcceptEligible(p, profile({ mode: 'auto', autoAccept: true })), true);
  assert.equal(autoAcceptEligible(p, profile({ mode: 'auto', autoAccept: false })), false);
});

test('budget unknown is a lifeline that stays loud even with zero interrupt budget', () => {
  const p = project({ budget: { spentMinor: 100, capMinor: 500, unknown: true } });
  const d = buildPortfolioDigest({ projects: [p], profiles: { p1: profile({ maxInterruptsPerDay: 0 }) }, now: NOW });
  const item = d.realtime.find(entry => entry.kind === 'budget');
  assert.ok(item);
  assert.equal(item!.severity, 'high');
  assert.equal(item!.defaultAction, 'hold');
});

test('irreversible op is never auto and always defaults to hold', () => {
  const p = project({ irreversiblePending: [{ id: 'publish', summary: '发布到生产' }] });
  const d = buildPortfolioDigest({ projects: [p], profiles: { p1: profile({ mode: 'auto', autoAccept: true }) }, now: NOW });
  const item = d.realtime.find(entry => entry.kind === 'irreversible');
  assert.ok(item);
  assert.equal(item!.defaultAction, 'hold');
});

test('consecutive failures is a high-severity anomaly (at_risk, pause default)', () => {
  const d = buildPortfolioDigest({ projects: [project({ consecutiveFailures: 2 })], profiles: { p1: profile() }, now: NOW });
  const item = d.realtime.find(entry => entry.kind === 'anomaly' && entry.summary.includes('连续失败'));
  assert.ok(item);
  assert.equal(item!.severity, 'high');
  assert.equal(item!.bucket, 'at_risk');
  assert.equal(item!.defaultAction, 'pause');
});

test('interrupt budget caps non-critical realtime and defers the rest to digest', () => {
  const p = project({ blockers: [
    { id: 'b1', severity: 'medium' }, { id: 'b2', severity: 'medium' }, { id: 'b3', severity: 'medium' },
  ] });
  const d = buildPortfolioDigest({ projects: [p], profiles: { p1: profile({ maxInterruptsPerDay: 1 }) }, now: NOW });
  assert.equal(d.realtime.length, 1);
  assert.equal(d.digest.length, 2);
  assert.ok(d.notes.some(note => note.includes('降噪')));
});

test('collectEscalations covers all five kinds', () => {
  const p = project({
    budget: { spentMinor: 900, capMinor: 500, unknown: false },
    consecutiveFailures: 3,
    irreversiblePending: [{ id: 'op', summary: '合并主干' }],
    pendingDecisions: [
      { decisionId: 'c', kind: 'proposal', question: '变更' },
      { decisionId: 'a', kind: 'acceptance', question: '验收' },
    ],
  });
  const kinds = new Set(collectEscalations(p, profile(), NOW).map(item => item.kind));
  for (const kind of ['budget', 'anomaly', 'irreversible', 'contract', 'acceptance'] as const) {
    assert.equal(kinds.has(kind), true, 'missing kind ' + kind);
  }
});

test('portfolio aggregates across projects with totals', () => {
  const projects = [
    project({ projectId: 'p1' }),
    project({ projectId: 'p2', name: '项目二', pendingDecisions: [{ decisionId: 'c', kind: 'proposal', question: '变更' }] }),
    project({ projectId: 'p3', name: '项目三', accepted: true }),
  ];
  const profiles = {
    p1: defaultAutonomyProfile('p1'), p2: defaultAutonomyProfile('p2'), p3: defaultAutonomyProfile('p3'),
  };
  const d = buildPortfolioDigest({ projects, profiles, now: NOW });
  assert.equal(d.totals.projects, 3);
  assert.equal(d.totals.healthy, 2); // p1 + 已验收的 p3
  assert.ok(d.realtime.some(entry => entry.projectId === 'p2'));
});

test('store persists autonomy profile and governance records daily interrupts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming portfolio '));
  try {
    const store = new PortfolioGovernanceStore(dir);
    store.setProfile({ ...defaultAutonomyProfile('p1'), mode: 'managed', maxInterruptsPerDay: 1, spendCapMinor: null });

    const reopened = new PortfolioGovernanceStore(dir);
    const saved = reopened.getProfile('p1');
    assert.equal(saved.mode, 'managed');
    assert.equal(saved.maxInterruptsPerDay, 1);
    assert.equal(saved.spendCapMinor, null);

    const projects = [project({ blockers: [{ id: 'b1', severity: 'medium' }] })];
    const gov = new PortfolioGovernance(reopened);
    const first = gov.digest(projects, NOW);
    assert.equal(first.realtime.length, 1);
    const dayKey = new Date(NOW).toISOString().slice(0, 10);
    assert.equal(reopened.interruptsFor(dayKey)['p1'], 1);

    const second = gov.digest(projects, NOW);
    assert.equal(second.realtime.length, 0);
    assert.equal(second.digest.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
