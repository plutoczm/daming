/**
 * 重灌干净 demo 数据：清掉旧 providers/agents/groups/profiles/请求，写入一版中文干净示例。
 * 用法：node scripts/seed-clean-demo.mjs http://127.0.0.1:3210 <TOKEN>
 * 需要 Host 正在运行（单用户本机）。
 */
const base = process.argv[2] || 'http://127.0.0.1:3210';
const token = process.argv[3] || '';
if (!token) { console.error('usage: node scripts/seed-clean-demo.mjs <base> <token>'); process.exit(2); }

const boot = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
const cookie = (boot.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] || '';
const sess = await fetch(base + '/api/session', { headers: { cookie } }).then((r) => r.json());
const csrf = sess.csrfToken;
const H = { cookie, origin: base, 'content-type': 'application/json', 'x-daming-csrf': csrf };
const j = async (path) => (await fetch(base + path, { headers: { cookie } })).json();
const del = (path) => fetch(base + path, { method: 'DELETE', headers: H });
const post = (path, body) => fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) });

// 1) 清空
const cat = await j('/api/platform/catalog');
for (const p of cat.providers ?? []) await del('/api/platform/providers?id=' + encodeURIComponent(p.id));
for (const a of cat.agents ?? []) await del('/api/platform/agents?id=' + encodeURIComponent(a.agentId));
const grp = await j('/api/platform/groups');
for (const g of grp.groups ?? []) await del('/api/platform/groups?id=' + encodeURIComponent(g.groupId));
const prof = await j('/api/platform/profiles');
for (const p of prof.profiles ?? []) await del('/api/platform/profiles?id=' + encodeURIComponent(p.profileId));
await del('/api/gateway/requests');
console.log('cleared old demo data');

// 2) 种子：供应商（本机 ollama，真实可用）
await post('/api/platform/providers', { id: 'ollama', api: 'openai-completions', baseUrl: 'http://localhost:11434', models: ['qwen3:8b'] });

// 2) Agent（中文名，UTF-8 正确）
await post('/api/platform/agents', { agentId: 'architect', name: '架构师', runtime: 'dsh', providerId: 'ollama', modelId: 'qwen3:8b' });
await post('/api/platform/agents', { agentId: 'reviewer', name: '评审员', runtime: 'claude-code', providerId: 'ollama', modelId: 'qwen3:8b' });

// 2) 路由组 + Profile
await post('/api/platform/groups', { groupId: 'fast', name: '极速组', strategy: 'order', members: [{ providerId: 'ollama', modelId: 'qwen3:8b' }] });
await post('/api/platform/profiles', { profileId: 'budget', name: '省钱档', assignments: [{ agentId: 'reviewer', providerId: 'ollama', modelId: 'qwen3:8b' }] });

// 2) 干净请求（中文上下文标签）
const now = Date.now();
const reqs = [
  { requestId: 'clean-1', at: new Date(now - 0).toISOString(), agent: 'DeepSeek Harness', providerId: 'ollama', modelId: 'ollama/qwen3:8b', status: 'ok', latencyMs: 1850, firstTokenMs: 320, inputTokens: 128000, outputTokens: 640, cacheHitPercent: 99.6, costMinor: 0.14, maskedCount: 2, contextLimitTokens: 500000,
    contextParts: [{ label: '系统提示词', category: 'system', tokens: 6000 }, { label: '文件', category: 'files', tokens: 96000 }, { label: '会话内容', category: 'conversation', tokens: 26000 }] },
  { requestId: 'clean-2', at: new Date(now - 60000).toISOString(), agent: 'Claude Code', providerId: 'ollama', modelId: 'ollama/qwen3:8b', status: 'ok', latencyMs: 2400, firstTokenMs: 410, inputTokens: 96000, outputTokens: 512, cacheHitPercent: 98.9, costMinor: 0.11, maskedCount: 1, contextLimitTokens: 400000,
    contextParts: [{ label: '工具结果', category: 'tool_results', tokens: 31000 }, { label: '会话内容', category: 'conversation', tokens: 15000 }, { label: '文件', category: 'files', tokens: 24000 }] },
  { requestId: 'clean-3', at: new Date(now - 120000).toISOString(), agent: 'Codex', providerId: 'ollama', modelId: 'ollama/qwen3:8b', status: 'ok', latencyMs: 7600, firstTokenMs: 5200, inputTokens: 540000, outputTokens: 1200, cacheHitPercent: 99.97, costMinor: 0, maskedCount: 0, contextLimitTokens: 1000000,
    contextParts: [{ label: '会话内容', category: 'conversation', tokens: 138000 }, { label: '工具结果', category: 'tool_results', tokens: 30000 }, { label: '图片', category: 'files', tokens: 19900 }, { label: '文件', category: 'files', tokens: 14800 }] },
  { requestId: 'clean-4', at: new Date(now - 180000).toISOString(), agent: 'DeepSeek Harness', providerId: 'ollama', modelId: 'ollama/qwen3:8b', status: 'ok', latencyMs: 900, firstTokenMs: 210, inputTokens: 8000, outputTokens: 300, cacheHitPercent: 95, costMinor: 0.02, maskedCount: 0, contextLimitTokens: 500000,
    contextParts: [{ label: '系统提示词', category: 'system', tokens: 5000 }, { label: '会话内容', category: 'conversation', tokens: 3000 }] },
  { requestId: 'clean-5', at: new Date(now - 240000).toISOString(), agent: 'Claude Code', providerId: 'ollama', modelId: 'ollama/qwen3:8b', status: 'error', latencyMs: 800, inputTokens: 5000, outputTokens: 0, maskedCount: 1, error: 'timeout' }
];
for (const r of reqs) await post('/api/gateway/requests', r);

console.log('seeded clean demo: 1 provider, 2 agents, 1 group, 1 profile, 5 requests');
