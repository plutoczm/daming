import type { MagpieItemView, MagpieReadView } from '@daming/contracts';

// Explicit display projection. Raw Provider/Quota/Plugin records may contain login names,
// tokens, headers, paths, prompts and third-party error strings; none are sent to the Web UI.
const COLLECTION_KEYS = ['data', 'models', 'providers', 'plugins', 'groups', 'items', 'cards', 'agents', 'routes', 'requests', 'records', 'entries', 'history', 'updates'] as const;
const LABEL_ALIASES = new Set(['models', 'groups', 'agents']);
const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,79}$/i;
const SAFE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,70}(?:@(?:latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?))?$/i;

export function safeNpmPluginSpec(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 130 && SAFE_SPEC.test(value) && !value.includes('..');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeText(value: unknown, maximum = 64): string | undefined {
  if (typeof value !== 'string') return undefined;
  const str = value.trim();
  if (!str || str.length > maximum || /[@\\<>:\r\n]/.test(str) || /(?:key|token|secret|password|bearer|sk-)[=_-]/i.test(str)) return undefined;
  return str;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..') ? value : undefined;
}

function version(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 30 && /^[0-9a-z][0-9a-z.+_-]*$/i.test(value) ? value : undefined;
}

function entries(value: unknown, depth = 0): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object || depth > 2) return undefined;
  for (const key of COLLECTION_KEYS) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  for (const key of ['data', 'state', 'result']) {
    const nested = entries(object[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function providers(items: readonly unknown[]): MagpieItemView[] {
  return items.slice(0, 24).flatMap((row) => {
    const r = record(row);
    if (!r) return [];
    const id = safeId(r.id);
    if (!id) return [];
    const keys = Array.isArray(r.keyList) ? r.keyList.length : 0;
    const shown = typeof r.exposed === 'number' && Number.isSafeInteger(r.exposed) && r.exposed >= 0 ? r.exposed : 0;
    const status = r.off === true ? 'disabled' : r.ready === true ? 'ready' : 'needs_setup';
    return [{ name: safeText(r.name) ?? id, id, status, kind: 'provider',
      detail: keys + ' 个账号/密钥 · ' + shown + ' 个可用模型' } satisfies MagpieItemView];
  });
}

function quotas(items: readonly unknown[]): MagpieItemView[] {
  return items.slice(0, 24).flatMap((row) => {
    const r = record(row);
    if (!r) return [];
    const id = safeId(r.provider);
    if (!id) return [];
    const windows = Array.isArray(r.windows) ? r.windows : [];
    const w = record(windows[0]);
    const percentage = w?.remaining;
    const remainingPercent = typeof percentage === 'number' && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100
      ? Math.round(percentage * 10) / 10 : undefined;
    const when = w?.resetsAt;
    const resetsAt = typeof when === 'string' && !Number.isNaN(Date.parse(when)) && when.length <= 40 ? new Date(when).toISOString() : undefined;
    return [{
      name: id, id, kind: safeText(r.kind, 20) ?? 'quota', status: r.error ? 'error' : 'ready',
      detail: windows.length + ' 个额度窗口',
      ...(remainingPercent === undefined ? {} : { remainingPercent }),
      ...(resetsAt === undefined ? {} : { resetsAt })
    } satisfies MagpieItemView];
  });
}

function plugins(items: readonly unknown[]): MagpieItemView[] {
  return items.slice(0, 24).flatMap((row) => {
    const r = record(row);
    if (!r) return [];
    const spec = safeNpmPluginSpec(r.spec) ? r.spec : undefined;
    const baseName = spec?.replace(/@(?:latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)$/, '').split('/').at(-1);
    const name = safeText(r.ownName) ?? safeText(r.package) ?? safeText(baseName);
    if (!name) return [];
    return [{
      name, kind: 'plugin', status: r.error ? 'error' : r.off === true ? 'disabled' : 'ready',
      ...(version(r.version) ? { version: version(r.version) } : {}),
      ...(version(r.latest) ? { latest: version(r.latest) } : {}),
      ...(spec ? { installedSpec: spec } : {}),
      detail: Array.isArray(r.providers) ? r.providers.length + ' 个服务' : undefined
    } satisfies MagpieItemView];
  });
}

export function summarizeMagpieRead(alias: string, value: unknown): MagpieReadView {
  const list = entries(value);
  const labels: string[] = [];
  if (list && LABEL_ALIASES.has(alias)) {
    for (const item of list) {
      const r = record(item);
      const label = safeText(r?.name ?? r?.id ?? r?.model);
      if (!label) continue;
      labels.push(label);
      if (labels.length >= 6) break;
    }
  }
  const items = !list ? [] : alias === 'providers' ? providers(list)
    : alias === 'quotas' ? quotas(list)
    : alias === 'plugins' ? plugins(list)
    : [];
  return { alias, count: list?.length ?? null, labels, items, checkedAt: new Date().toISOString() };
}
