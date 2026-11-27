import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Agent 工作群：把多个 Agent 拉进一个像微信群的空间，互相讨论、用户可见、可增删、可插话指导。
// 本轮先落「可信离线 fixture 讨论」：每个成员按 runtime 扮演角色、引用上一条发言产出讨论内容；
// 真·模型发言由调用方（后续接真实执行器）注入 responder 替换，契约不变。

export interface RoomMember {
  readonly agentId: string;
  readonly name: string;
  readonly runtime: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface RoomMessage {
  readonly id: string;
  readonly at: string;
  readonly role: 'user' | 'agent' | 'system';
  readonly agentId?: string;
  readonly name: string;
  readonly text: string;
}

export interface AgentRoomView {
  readonly roomId: string;
  readonly title: string;
  readonly members: readonly RoomMember[];
  readonly messages: readonly RoomMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 发言器：给定成员 + 最近一条用户消息与转录，返回该成员本轮发言文本（可为真实模型异步结果）。 */
export type RoomResponder = (member: RoomMember, context: { readonly userText: string; readonly transcript: string }) => string | Promise<string>;

interface RoomFile { rooms: AgentRoomView[] }

let counter = 0;
function makeId(prefix: string): string {
  counter = (counter + 1) % 100000;
  return prefix + '-' + Date.now().toString(36) + '-' + counter.toString(36);
}

function persona(runtime: string): string {
  const key = (runtime || '').toLowerCase();
  if (key.includes('dsh')) return '统筹';
  if (key.includes('codex')) return '实现';
  if (key.includes('claude')) return '评审';
  return '协作';
}

export class AgentRoomStore {
  private readonly file: string;
  private data: RoomFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'rooms.json');
    this.data = this.load();
  }
  private load(): RoomFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as RoomFile;
      if (raw && Array.isArray(raw.rooms)) return raw;
    } catch { /* 首次运行 */ }
    return { rooms: [] };
  }
  private persist(): void { writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8'); }
  list(): AgentRoomView[] { return this.data.rooms.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)); }
  get(roomId: string): AgentRoomView | undefined { return this.data.rooms.find((room) => room.roomId === roomId); }
  create(input: { title?: string; members?: RoomMember[] }): AgentRoomView {
    const now = new Date().toISOString();
    const members = (input.members || []).filter((member, index, all) => all.findIndex((m) => m.agentId === member.agentId) === index);
    const messages: RoomMessage[] = members.length
      ? [{ id: makeId('msg'), at: now, role: 'system', name: '系统', text: '已把 ' + members.map((m) => m.name).join('、') + ' 拉进群。' }]
      : [];
    const room: AgentRoomView = {
      roomId: makeId('room'),
      title: (input.title || 'Agent 工作群').trim(),
      members,
      messages,
      createdAt: now,
      updatedAt: now
    };
    this.data.rooms.push(room); this.persist(); return room;
  }
  addMember(roomId: string, member: RoomMember): AgentRoomView | undefined {
    const room = this.get(roomId); if (!room) return undefined;
    if (room.members.some((m) => m.agentId === member.agentId)) return room;
    const next: AgentRoomView = { ...room, members: [...room.members, member], updatedAt: new Date().toISOString(),
      messages: [...room.messages, { id: makeId('msg'), at: new Date().toISOString(), role: 'system', name: '系统', text: '把 ' + member.name + ' 拉进了群。' }] };
    this.replace(next); return next;
  }
  removeMember(roomId: string, agentId: string): AgentRoomView | undefined {
    const room = this.get(roomId); if (!room) return undefined;
    const removed = room.members.find((m) => m.agentId === agentId);
    const next: AgentRoomView = { ...room, members: room.members.filter((m) => m.agentId !== agentId), updatedAt: new Date().toISOString(),
      messages: removed ? [...room.messages, { id: makeId('msg'), at: new Date().toISOString(), role: 'system', name: '系统', text: '把 ' + removed.name + ' 移出了群。' }] : room.messages };
    this.replace(next); return next;
  }
  removeRoom(roomId: string): boolean {
    const before = this.data.rooms.length;
    this.data.rooms = this.data.rooms.filter((room) => room.roomId !== roomId);
    if (this.data.rooms.length === before) return false;
    this.persist();
    return true;
  }
  /** Rename a room to a user-chosen title (trimmed, non-empty). */
  rename(roomId: string, title: string): AgentRoomView | undefined {
    const room = this.get(roomId); if (!room) return undefined;
    const trimmed = (title || '').trim();
    if (!trimmed) return room;
    const next: AgentRoomView = { ...room, title: trimmed, updatedAt: new Date().toISOString() };
    this.replace(next); return next;
  }
  postMessage(roomId: string, input: { role: RoomMessage['role']; name: string; text: string; agentId?: string }): AgentRoomView | undefined {
    const room = this.get(roomId); if (!room || !input.text.trim()) return undefined;
    const next: AgentRoomView = { ...room, updatedAt: new Date().toISOString(),
      messages: [...room.messages, { id: makeId('msg'), at: new Date().toISOString(), role: input.role, name: input.name, text: input.text.trim(), ...(input.agentId ? { agentId: input.agentId } : {}) }] };
    this.replace(next); return next;
  }
  private replace(next: AgentRoomView): void {
    const index = this.data.rooms.findIndex((room) => room.roomId === next.roomId);
    if (index >= 0) this.data.rooms[index] = next; else this.data.rooms.push(next);
    this.persist();
  }
}

/** 离线 fixture 发言器：按角色 + 引用上一条发言，产出可读的讨论内容（真模型接入时整体替换）。 */
export function fixtureRoomResponder(member: RoomMember, context: { userText: string; transcript: string }): string {
  const role = persona(member.runtime);
  const quote = (context.userText || '').replace(/\s+/g, ' ').slice(0, 48) || '上一条';
  const lines: Record<string, string> = {
    统筹: `收到「${quote}」。我先把目标拆成 3 步：明确验收 → 派给合适的 Agent → 回收结果对账。`,
    实现: `针对「${quote}」，我可以直接动手：给出可执行改法与最小验证用例，落地后回贴 diff。`,
    评审: `对「${quote}」我审一遍风险：边界情况、回归影响、以及是否需要补测试，评完给结论。`,
    协作: `关于「${quote}」，我跟进并补充所需信息，和 @${member.name} 对齐后再推进。`
  };
  return `【${member.name}·${role}】` + (lines[role] ?? lines.协作);
}

/** 让群里每个成员依次就最近一条用户消息发言一轮，返回更新后的房间（responder 可异步/真实模型）。 */
export async function discuss(store: AgentRoomStore, roomId: string, responder: RoomResponder): Promise<AgentRoomView | undefined> {
  let room = store.get(roomId); if (!room) return undefined;
  if (!room.members.length) return room;
  const lastUser = [...room.messages].reverse().find((message) => message.role === 'user');
  const userText = lastUser?.text ?? '';
  const transcript = room.messages.slice(-8).map((message) => `${message.name}: ${message.text}`).join('\n');
  for (const member of room.members) {
    const text = await responder(member, { userText, transcript });
    room = store.postMessage(roomId, { role: 'agent', name: member.name, agentId: member.agentId, text }) ?? room;
  }
  return room;
}
