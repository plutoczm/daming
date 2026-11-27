/**
 * A safe, read-only bridge to Magpie's effective Routing page.
 * Magpie remains the ONLY owner of providers, subscription Agents,
 * credentials, route-group policies, fallback and gateway execution.
 */
export type MagpieTargetKind = 'llm' | 'agent-backed' | 'route-group';
export interface MagpieUnifiedTarget {
  readonly targetId: string; // The exact Magpie gateway model/group route.
  readonly label: string; readonly kind: MagpieTargetKind;
  readonly providerId: string | null;
  readonly members: number;
  readonly ready: true;
}
export interface MagpieUnifiedCatalog {
  readonly source: 'magpie-native-routing';
  readonly checkedAt: string;
  readonly targets: readonly MagpieUnifiedTarget[];
  readonly dispatchEnabled: false;
  readonly managesCredentialsInMagpie: true;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:/+-]{0,159}$/i;
const SAFE_LABEL = /^[\p{L}\p{N} ._:/+()\-]{1,90}$/u;
const TARGET_LIMIT = 160;
type Dict = Record<string, unknown>;
const record = (v: unknown): Dict | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Dict : null;
function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) &&
    !value.includes('..') && !value.includes('://') && !/^(?:sk-|key|token|bearer|ghp_)/i.test(value);
}
function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_LABEL.test(value) &&
    !/@|:\/\/|secret|apikey|password|token|bearer/i.test(value)
    ? value : fallback;
}
function takeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 256) : [];
}

/** Accept only the official /api/groups effective catalog. Arbitrary provider
 * account records, prices, API URLs, login names and raw models are NEVER
 * sent to Daming Web or persisted in its task bindings. */
export function projectMagpieUnifiedTargets(
  raw: unknown, clock: () => Date = () => new Date()
): MagpieUnifiedCatalog {
  const source = record(raw);
  if (!source || !Array.isArray(source.models) ||
      !Array.isArray(source.groups)) {
    throw new Error('magpie_native_routing_schema_invalid');
  }
  const targets: MagpieUnifiedTarget[] = [];
  const seen = new Set<string>();
  const add = (target: MagpieUnifiedTarget) => {
    if (seen.has(target.targetId) || targets.length >= TARGET_LIMIT) return;
    seen.add(target.targetId); targets.push(target);
  };
  for (const rawModel of takeArray(source.models)) {
    const model = record(rawModel);
    if (!model || !safeId(model.id) || !model.id.includes('/') ||
        typeof model.sub !== 'boolean' && model.sub !== undefined) continue;
    const provider = String(model.id.split('/')[0]);
    if (!safeId(provider)) continue;
    add({
      targetId: model.id, kind: model.sub === true ? 'agent-backed' : 'llm',
      providerId: provider,
      label: label(model.name, model.id),
      ready: true, members: 1
    });
  }
  for (const rawGroup of takeArray(source.groups)) {
    const group = record(rawGroup);
    if (!group || group.ready !== true || group.decides === true ||
        !safeId(group.ref) ||
        !(group.ref.startsWith('group/') || group.ref.startsWith('auto/'))) continue;
    const count = takeArray(group.members).length;
    if (count === 0) continue;
    add({
      targetId: group.ref, kind: 'route-group', providerId: null,
      label: label(group.name, group.ref),
      ready: true, members: Math.min(count, 256)
    });
  }
  return {
    source: 'magpie-native-routing', checkedAt: clock().toISOString(),
    targets, dispatchEnabled: false, managesCredentialsInMagpie: true
  };
}

export const MAGPIE_ROLES = ['router', 'research', 'analysis', 'delivery'] as const;
export type MagpieRole = typeof MAGPIE_ROLES[number];
export interface MagpieRoleAssignment {
  readonly role: MagpieRole;
  readonly targetId: string;
}
/** Planning never invokes the model. Rejects stale or injected targets. */
export function validateMagpieRoleAssignments(
  assignments: unknown, catalog: MagpieUnifiedCatalog
): MagpieRoleAssignment[] {
  if (!Array.isArray(assignments) || assignments.length < 1 ||
      assignments.length > MAGPIE_ROLES.length) {
    throw new Error('magpie_role_plan_invalid');
  }
  const active = new Set(catalog.targets.map(t => t.targetId));
  const roles = new Set<string>();
  return assignments.map((entry: unknown) => {
    const v = record(entry);
    if (!v || Object.keys(v).length !== 2 ||
        !MAGPIE_ROLES.includes(v.role as MagpieRole) ||
        !safeId(v.targetId) || !active.has(v.targetId) ||
        roles.has(String(v.role))) throw new Error('magpie_role_plan_invalid');
    roles.add(String(v.role));
    return { role: v.role as MagpieRole, targetId: v.targetId };
  });
}


/** Fallback for an ALREADY RUNNING Magpie app accessed through a user-issued
 * gateway key. GET /v1/models exposes route IDs, not native account types.
 * Subscription/Agent classification is only asserted when Magpie reports it.
 */
export function projectMagpieGatewayTargets(
  raw: unknown, clock: () => Date = () => new Date()
): MagpieUnifiedCatalog {
  const source = record(raw);
  if (!source || !Array.isArray(source.data)) {
    throw new Error('magpie_gateway_models_schema_invalid');
  }
  const targets: MagpieUnifiedTarget[] = [];
  const seen = new Set<string>();
  for (const item of source.data.slice(0, 256)) {
    const m = record(item);
    if (!m || !safeId(m.id) || seen.has(m.id) || targets.length >= TARGET_LIMIT) continue;
    if (!m.id.includes('/')) continue; // provider/model or group/id
    const isGroup = m.id.startsWith('group/') || m.id.startsWith('auto/');
    const providerId = isGroup ? null : m.id.split('/')[0];
    if (!isGroup && !safeId(providerId)) continue;
    seen.add(m.id);
    targets.push({
      targetId: m.id,
      label: label(m.name, m.id),
      kind: isGroup ? 'route-group' : m.sub === true ? 'agent-backed' : 'llm',
      providerId, members: 0, ready: true
    });
  }
  return {
    source: 'magpie-native-routing', checkedAt: clock().toISOString(),
    targets, dispatchEnabled: false, managesCredentialsInMagpie: true
  };
}
