import { createMagpieHost } from '../apps/server/src/magpie-host.ts';
const dataDir = process.env.DAMING_MAGPIE_DATA_DIR ?? join_default();
function join_default(){ return (process.env.LOCALAPPDATA ?? '.') + '\\Daming\\magpie-headless'; }
const host = createMagpieHost({ dataDir });
try {
  const status = await host.ensure();
  console.log('STATUS', JSON.stringify(status));
  console.log('SCOPE', await host.scopeCapability?.());
  try {
    const catalog = await host.routingCatalog();
    console.log('ROUTING instanceId', catalog.instanceId, 'candidates', JSON.stringify(catalog.candidates.map(c => ({ p: c.providerId, m: c.modelId, a: String(c.accountRef).slice(-4), t: c.accountType }))));
  } catch (e) { console.log('ROUTING_ERR', e.message); }
  try {
    const uni = await host.unifiedTargets?.();
    console.log('UNIFIED', JSON.stringify({ source: uni?.source, targets: uni?.targets?.map(t => ({ id: t.targetId, kind: t.kind, ready: t.ready })) }));
  } catch (e) { console.log('UNIFIED_ERR', e.message); }
  for (const m of ['gpt-6.1-sol','gpt-6.2-sol']) {
    try { const b = await host.codexSubscriptionBinding?.(m); console.log('CODEX_BIND', m, JSON.stringify({ p: b.providerId, m: b.modelId, a: String(b.accountRef).slice(-4), k: b.accountKind })); }
    catch (e) { console.log('CODEX_BIND_ERR', m, e.message); }
  }
} catch (e) { console.log('FATAL', e.message); }
finally { host.stop(); }
