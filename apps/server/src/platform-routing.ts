/**
 * 路由组 + Profile（P0，对齐 Magpie 的 group / profile）。
 *  - RoutingGroup：多个 provider/model 合成一个 selector（`group/<id>`），策略 order/round。
 *  - Profile：一组「agent → provider/model」赋值，可一键整体切换。
 * 配置驱动、JSON 持久化，不依赖桌面 App。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfileStore } from './platform-catalog.ts';

const ID = /^[a-z0-9][a-z0-9._-]{1,39}$/i;

export class RoutingError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

export interface RoutingMember { readonly providerId: string; readonly modelId: string; }
export interface RoutingGroup { readonly groupId: string; readonly name: string; readonly members: readonly RoutingMember[]; readonly strategy: 'order' | 'round'; readonly createdAt: string; }
export interface ProfileAssignment { readonly agentId: string; readonly providerId: string; readonly modelId: string; }
export interface RoutingProfile { readonly profileId: string; readonly name: string; readonly assignments: readonly ProfileAssignment[]; readonly createdAt: string; }

function str(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim()) throw new RoutingError(400, 'missing_' + field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new RoutingError(400, 'too_long_' + field);
  return trimmed;
}
function members(raw: unknown): RoutingMember[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RoutingError(400, 'missing_members');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new RoutingError(400, 'invalid_member');
    const item = entry as Record<string, unknown>;
    return { providerId: str(item.providerId, 'provider_id', 40), modelId: str(item.modelId, 'model_id', 120) };
  });
}
function assignments(raw: unknown): ProfileAssignment[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RoutingError(400, 'missing_assignments');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new RoutingError(400, 'invalid_assignment');
    const item = entry as Record<string, unknown>;
    return { agentId: str(item.agentId, 'agent_id', 40), providerId: str(item.providerId, 'provider_id', 40), modelId: str(item.modelId, 'model_id', 120) };
  });
}

interface GroupFile { groups: RoutingGroup[] }
export class RoutingGroupStore {
  private readonly file: string;
  private data: GroupFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'routing-groups.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<GroupFile> | null;
      this.data = parsed && Array.isArray(parsed.groups) ? { groups: parsed.groups } : { groups: [] };
    } catch { this.data = { groups: [] }; }
  }
  private persist() { try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ } }
  list(): RoutingGroup[] { return [...this.data.groups]; }
  add(raw: unknown): RoutingGroup {
    if (!raw || typeof raw !== 'object') throw new RoutingError(400, 'invalid_group');
    const input = raw as Record<string, unknown>;
    const groupId = str(input.groupId, 'group_id', 40);
    if (!ID.test(groupId)) throw new RoutingError(400, 'invalid_group_id');
    const strategy = input.strategy === 'round' ? 'round' : 'order';
    const group: RoutingGroup = { groupId, name: input.name === undefined ? groupId : str(input.name, 'name', 80), members: members(input.members), strategy, createdAt: new Date().toISOString() };
    this.data.groups = [...this.data.groups.filter((g) => g.groupId !== groupId), group];
    this.persist();
    return group;
  }
  remove(groupId: string): boolean {
    const before = this.data.groups.length;
    this.data.groups = this.data.groups.filter((g) => g.groupId !== groupId);
    if (this.data.groups.length === before) return false;
    this.persist();
    return true;
  }
}

interface ProfileFile { profiles: RoutingProfile[] }
export class ProfileStore {
  private readonly file: string;
  private data: ProfileFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'routing-profiles.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<ProfileFile> | null;
      this.data = parsed && Array.isArray(parsed.profiles) ? { profiles: parsed.profiles } : { profiles: [] };
    } catch { this.data = { profiles: [] }; }
  }
  private persist() { try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ } }
  list(): RoutingProfile[] { return [...this.data.profiles]; }
  get(profileId: string): RoutingProfile | undefined { return this.data.profiles.find((p) => p.profileId === profileId); }
  add(raw: unknown): RoutingProfile {
    if (!raw || typeof raw !== 'object') throw new RoutingError(400, 'invalid_profile');
    const input = raw as Record<string, unknown>;
    const profileId = str(input.profileId, 'profile_id', 40);
    if (!ID.test(profileId)) throw new RoutingError(400, 'invalid_profile_id');
    const profile: RoutingProfile = { profileId, name: input.name === undefined ? profileId : str(input.name, 'name', 80), assignments: assignments(input.assignments), createdAt: new Date().toISOString() };
    this.data.profiles = [...this.data.profiles.filter((p) => p.profileId !== profileId), profile];
    this.persist();
    return profile;
  }
  remove(profileId: string): boolean {
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter((p) => p.profileId !== profileId);
    if (this.data.profiles.length === before) return false;
    this.persist();
    return true;
  }
}

/** 把 Profile 的赋值一次性应用到 Agent 档案（批量切换 LLM）。返回应用与跳过明细。 */
export function applyProfile(profile: RoutingProfile, agents: AgentProfileStore): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const assignment of profile.assignments) {
    if (!agents.get(assignment.agentId)) { skipped.push(assignment.agentId); continue; }
    agents.setModel(assignment.agentId, assignment.providerId, assignment.modelId);
    applied.push(assignment.agentId);
  }
  return { applied, skipped };
}
