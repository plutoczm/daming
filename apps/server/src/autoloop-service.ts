import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { AutoloopAgentHealthView } from '@daming/contracts';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AutoloopCardView, AutoloopStateView } from '@daming/contracts';
import {
  commitLatest, decide, initialize, openView, parseRules, rows
} from '@daming/autoloop';
import type { Fact, Job, Result, Row, Rules, View } from '@daming/autoloop';

const FORMAT = 'daming-autoloop-v1';
const WORKER = 'daming-inprocess';

const DEFAULT_RULES: Rules = {
  timezone: 'Asia/Shanghai',
  askFirst: [],
  sources: {
    manual: { name: '手动事件' }
  },
  agents: {
    echo: { name: 'Echo 演示 Agent', worker: WORKER, use: 'echo', access: 'read' },
    dsh: { name: 'DSH Real', worker: WORKER, use: 'dsh', access: 'read' },
    codex: { name: 'Codex Real', worker: WORKER, use: 'codex', access: 'read' },
    mission: { name: '大铭离线多角色任务', worker: WORKER, use: 'mission', access: 'read' }
  },
  channels: {},
  rules: [{
    name: '手动测试', when: { source: 'manual', types: ['task.requested'] },
    to: 'echo', cwd: 'D:/Projects/daming', group: 'manual-echo', tell: 'needed', prompt: '处理事件'
  }, {
    name: '真实 DSH 测试', when: { source: 'manual', types: ['task.requested.dsh'] },
    to: 'dsh', cwd: 'D:/Projects/daming', group: 'manual-real', tell: 'needed', prompt: '处理 Autoloop 事件并给出结果。'
  }, {
    name: '真实 Codex 测试', when: { source: 'manual', types: ['task.requested.codex'] },
    to: 'codex', cwd: 'D:/Projects/daming', group: 'manual-real', tell: 'needed', prompt: 'Reply with only OK. Do not run commands or edit files.'
  }, {
    name: '大铭指挥中心离线决策', when: { source: 'manual', types: ['mission.requested'] },
    to: 'mission', cwd: 'D:/Projects/daming', group: 'mission-offline', tell: 'needed', prompt: 'Only generate an offline approval card.'
  }],
  elsewhere: []
};

export interface AutoloopService {
  readonly enabled: boolean;
  state(): AutoloopStateView;
  emit(event: { id: string; type: string; subject?: string; summary?: string; detail?: string; link?: string }): Promise<{ event: number; duplicate: boolean; routed: string[] }>;
  answer(cardId: number, input: { choice?: number; text?: string }): { changed: boolean; state: string };
  tick(): Promise<void>;
  close(): void;
}

export function createAutoloopService(options: {
  readonly dataDir: string;
  readonly rulesFile?: string;
  readonly runJob?: (job: Job) => Promise<Result>;
  readonly agentHealth?: readonly AutoloopAgentHealthView[];
}): AutoloopService {
  const dir = join(options.dataDir, 'autoloop');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'hub.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  initialize(db);
  const environment = { secret: randomBytes(32).toString('base64url'), publicUrl: '' };
  let view: View = openView(db, FORMAT);

  function dispatch(type: string, args: unknown[], now = Date.now()): unknown {
    let value: unknown;
    view = commitLatest(db, FORMAT, (latest) => {
      const decided = decide(latest, { type, args }, now, environment);
      value = decided.value;
      return decided.facts;
    });
    return value;
  }

  const storedRules = view.get('config', 'rules')?.value as Rules | undefined;
  const oldDefault = storedRules !== undefined && Object.keys(storedRules.agents).length === 1 && storedRules.agents.echo !== undefined && storedRules.rules.length === 1 && storedRules.rules[0]?.name === '手动测试';
  const previousBuiltIn = !!storedRules && !storedRules.agents.mission &&
    Object.keys(storedRules.agents).sort().join(',') === 'codex,dsh,echo' &&
    storedRules.rules.length === 3 &&
    storedRules.rules.every((rule) => ['手动测试', '真实 DSH 测试', '真实 Codex 测试'].includes(rule.name)) &&
    Object.keys(storedRules.channels).length === 0;
  if (!storedRules || oldDefault || previousBuiltIn) dispatch('rules', [DEFAULT_RULES]);
  const rulesFile = options.rulesFile ?? join(options.dataDir, 'autoloop-rules.json');
  if (existsSync(rulesFile)) {
    try { dispatch('rules', [parseRules(readFileSync(rulesFile, 'utf8'), Date.now(), 'Asia/Shanghai')]); }
    catch { /* keep the built-in rules; the UI state shows the active rule set */ }
  }

  async function drain(): Promise<void> {
    for (let iteration = 0; iteration < 20; iteration++) {
      const job = dispatch('claimNext', [WORKER, `daming-${randomUUID()}`]) as Job | null;
      if (!job) return;
      dispatch('started', [job.run, job.token, { session: `autoloop-run-${job.run}` }]);
      let result: Result;
      try {
        result = options.runJob
          ? await options.runJob(job)
          : job.agent.use === 'echo'
            ? { outcome: 'done', summary: `已处理事件：${job.context.events.map((event) => event.summary || event.type).join('；') || '无事件'}` }
            : { outcome: 'failed', error: `未配置 Agent 适配器：${job.agent.use}` };
      } catch (error) {
        result = { outcome: 'failed', error: error instanceof Error ? error.message : 'agent_failed' };
      }
      dispatch('finish', [job.run, job.token, result]);
    }
  }

  function state(): AutoloopStateView {
    const config = view.get('config', 'rules')!.value as Rules;
    const runRows = view.select('runs', {}, 30, true);
    const cards = rows(view, 'cards', { state: 'open' });
    const count = (stateName: string) => rows(view, 'runs', { state: stateName }).length;
    return {
      enabled: true,
      agentHealth: options.agentHealth ?? [],
      totals: {
        running: count('claimed') + count('unknown'),
        queued: count('queued'),
        done: count('done') + count('nothing'),
        cards: cards.length
      },
      sources: Object.entries(config.sources).map(([id, source]) => ({ id, name: source.name })),
      agents: Object.entries(config.agents).map(([id, agent]) => ({ id, name: agent.name, use: agent.use, worker: agent.worker })),
      channels: Object.entries(config.channels).map(([id, channel]) => ({ id, name: channel.name })),
      rules: config.rules.map((rule) => ({ name: rule.name, when: 'cron' in rule.when ? rule.when.cron : `${rule.when.source}:${rule.when.types.join(',')}`, to: rule.to })),
      runs: runRows.map((run: Row) => ({
        id: Number(run.id), rule: String(run.rule), agent: String(run.agent), state: String(run.state),
        createdAt: String(run.created_at), summary: run.summary ? String(run.summary) : undefined
      })),
      cards: cards.map((card: Row): AutoloopCardView => ({
        id: Number(card.id), kind: card.kind === 'ask' ? 'ask' : 'notice', state: String(card.state),
        title: String(card.title), text: String(card.text), options: JSON.parse(String(card.options ?? '[]')) as string[]
      }))
    };
  }

  return {
    enabled: true,
    state,
    async emit(event) {
      const value = dispatch('ingest', ['manual', event]) as { event: number; duplicate: boolean; routed: string[] };
      await drain();
      return value;
    },
    answer(cardId, input) {
      const value = dispatch('answer', [cardId, { ...input, by: '本人' }]) as { changed: boolean; state: string };
      return value;
    },
    async tick() { dispatch('tick', []); await drain(); },
    close() { db.close(); }
  };
}
