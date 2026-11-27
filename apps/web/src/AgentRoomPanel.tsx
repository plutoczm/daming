import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProfileView, PlatformCatalogView, SessionView } from '@daming/contracts';
import { agentLogo } from './provider-logos.ts';

interface RoomMember { readonly agentId: string; readonly name: string; readonly runtime: string; readonly providerId?: string; readonly modelId?: string }
interface RoomMessage { readonly id: string; readonly at: string; readonly role: 'user' | 'agent' | 'system'; readonly agentId?: string; readonly name: string; readonly text: string }
interface AgentRoom { readonly roomId: string; readonly title: string; readonly members: readonly RoomMember[]; readonly messages: readonly RoomMessage[]; readonly createdAt: string; readonly updatedAt: string }

/** Agent 工作群：像微信群一样把多个 Agent 拉进来，互相讨论（内容可见），可增删 Agent、可插话指导。 */
export function AgentRoomPanel({ session }: { session: SessionView }) {
  const csrf = session.csrfToken;
  const [rooms, setRooms] = useState<AgentRoom[]>([]);
  const [agents, setAgents] = useState<AgentProfileView[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [text, setText] = useState('');
  const [discussOnSend, setDiscussOnSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [menu, setMenu] = useState<{ roomId: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const [roomRes, catRes] = await Promise.all([
      fetch('/api/rooms', { credentials: 'same-origin' }),
      fetch('/api/platform/catalog', { credentials: 'same-origin' })
    ]);
    if (roomRes.ok) {
      const data = await roomRes.json() as { rooms?: AgentRoom[] };
      const list = data.rooms ?? [];
      setRooms(list);
      setActiveId((current) => (current && list.some((room) => room.roomId === current) ? current : (list[0]?.roomId ?? '')));
    }
    if (catRes.ok) { const cat = await catRes.json() as PlatformCatalogView; setAgents([...(cat.agents ?? [])]); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);

  // 关闭右键菜单：任意点击 / 滚动 / Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const active = useMemo(() => rooms.find((room) => room.roomId === activeId) ?? null, [rooms, activeId]);
  const memberOf = useCallback((agentId?: string) => active?.members.find((member) => member.agentId === agentId), [active]);

  useEffect(() => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; }, [active?.messages.length]);

  const call = async (path: string, method: 'POST' | 'DELETE' | 'PATCH', body?: unknown): Promise<AgentRoom | null> => {
    const response = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-daming-csrf': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => ({})) as { room?: AgentRoom; reason?: string };
    if (!response.ok) throw new Error(String(data.reason ?? 'request_failed'));
    return data.room ?? null;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNote('');
    try { await fn(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); void label; }
  };

  const createRoom = () => run('create', async () => {
    const members = agents.map((agent) => ({ agentId: agent.agentId, name: agent.name, runtime: agent.runtime, ...(agent.providerId ? { providerId: agent.providerId } : {}), ...(agent.modelId ? { modelId: agent.modelId } : {}) }));
    const room = await call('/api/rooms', 'POST', { title: 'Agent 工作群', members });
    if (room) setActiveId(room.roomId);
    setNote('已把 ' + members.length + ' 个 Agent 拉进新群');
  });

  const addMember = () => run('add', async () => {
    if (!active || !picker) return;
    const agent = agents.find((item) => item.agentId === picker);
    if (!agent) return;
    await call('/api/rooms/' + active.roomId + '/members', 'POST', { agentId: agent.agentId, name: agent.name, runtime: agent.runtime, ...(agent.providerId ? { providerId: agent.providerId } : {}), ...(agent.modelId ? { modelId: agent.modelId } : {}) });
    setPicker(''); setNote('已拉入 ' + agent.name);
  });

  const removeMember = (agentId: string, name: string) => run('remove', async () => { if (!active) return; await call('/api/rooms/' + active.roomId + '/members?id=' + encodeURIComponent(agentId), 'DELETE'); setNote('已移出 ' + name); });

  const removeRoom = (roomId: string, title: string) => {
    if (!window.confirm('解散群「' + title + '」？')) return;
    void run('removeRoom', async () => {
      await call('/api/rooms/' + roomId, 'DELETE');
      if (activeId === roomId) setActiveId('');
      setNote('已解散群「' + title + '」');
    });
  };

  const send = () => run('send', async () => {
    if (!active) return;
    const value = text.trim();
    if (!value) return;
    await call('/api/rooms/' + active.roomId + '/messages', 'POST', { text: value, discuss: discussOnSend });
    setText('');
  });

  const discussNow = () => run('discuss', async () => { if (!active) return; await call('/api/rooms/' + active.roomId + '/discuss', 'POST'); });

  const startRename = () => { if (!active) return; setTitleDraft(active.title); setEditingTitle(true); };
  const startRenameRoom = (room: AgentRoom) => { setActiveId(room.roomId); setTitleDraft(room.title); setEditingTitle(true); setMenu(null); };
  const saveRename = () => run('rename', async () => {
    if (!active) return;
    const value = titleDraft.trim();
    if (!value || value === active.title) { setEditingTitle(false); return; }
    await call('/api/rooms/' + active.roomId, 'PATCH', { title: value });
    setEditingTitle(false);
    setNote('已把群重命名为「' + value + '」');
  });

  const canWrite = session.role === 'readwrite';
  const availableToAdd = agents.filter((agent) => !active?.members.some((member) => member.agentId === agent.agentId));

  return (
    <section className="page-stack" id="room" data-reveal>
      <header className="page-head">
        <div>
          <p className="eyebrow">AGENT WORKSPACE / GROUP CHAT</p>
          <h2>协作群</h2>
          <p className="hint">把所有 Agent 拉进一个像微信工作群的空间：它们互相讨论、你能全程看到内容，随时拉人、踢人、插话指导。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ghost-btn" onClick={() => void load()} disabled={busy}>刷新</button>
          {canWrite && <button type="button" className="primary-btn" onClick={() => void createRoom()} disabled={busy || !agents.length}>＋ 新建群（拉全部 Agent）</button>}
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {note && <p className="hint" role="status">{note}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '236px 1fr', gap: 14, alignItems: 'start' }}>
        <aside className="status-card" style={{ padding: 10 }}>
          <div className="card-title"><h3>群 <span className="count">{rooms.length}</span></h3></div>
          {rooms.length ? rooms.map((room) => (
            <div key={room.roomId} style={{ marginBottom: 4 }}>
              <button type="button" onClick={() => setActiveId(room.roomId)}
                onContextMenu={(event) => { if (!canWrite) return; event.preventDefault(); setMenu({ roomId: room.roomId, x: event.clientX, y: event.clientY }); }}
                className={room.roomId === activeId ? 'dm-nav-item active' : 'dm-nav-item'}
                style={{ width: '100%', display: 'block', textAlign: 'left', padding: '8px 10px', borderRadius: 8, background: room.roomId === activeId ? '#eef0ff' : 'transparent', border: '1px solid ' + (room.roomId === activeId ? '#c7ccf8' : 'transparent'), cursor: 'pointer' }}>
                <div style={{ fontWeight: 600, color: '#111827' }}>{room.title}</div>
                <div className="hint" style={{ fontSize: 11 }}>{room.members.length} 成员 · {room.messages.length} 条</div>
              </button>
            </div>
          )) : <p className="hint">还没有群。点右上「新建群」把全部 Agent 拉进来。</p>}
          {canWrite && rooms.length > 0 && <p className="hint" style={{ fontSize: 10.5, marginTop: 6 }}>右键群名可重命名 / 解散</p>}
        </aside>

        <div className="status-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 460 }}>
          {active ? (
            <>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-2)' }}>
                <div className="card-title" style={{ marginBottom: 6 }}>
                  {editingTitle ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input value={titleDraft} autoFocus maxLength={80} onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveRename(); } if (event.key === 'Escape') setEditingTitle(false); }}
                        style={{ height: 28, minWidth: 200, fontSize: 15, fontWeight: 600 }} />
                      <button type="button" className="primary-btn" onClick={() => void saveRename()} disabled={busy}>保存</button>
                      <button type="button" className="ghost-btn" onClick={() => setEditingTitle(false)}>取消</button>
                    </span>
                  ) : (
                    <h3>{active.title}</h3>
                  )}
                  <span className="hint">{active.members.length} 位 Agent 在场</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {active.members.map((member) => (
                    <span className="chip" key={member.agentId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {agentLogo(member.runtime, member.agentId) ? <img src={agentLogo(member.runtime, member.agentId)} alt="" width={13} height={13} /> : null}
                      {member.name}
                      {canWrite && <button type="button" onClick={() => void removeMember(member.agentId, member.name)} title="移出群" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#ef4444', padding: 0, lineHeight: 1 }}>✕</button>}
                    </span>
                  ))}
                  {canWrite && availableToAdd.length > 0 && (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <select value={picker} onChange={(event) => setPicker(event.target.value)} style={{ height: 26 }}>
                        <option value="">＋ 加 Agent</option>
                        {availableToAdd.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}（{agent.runtime}）</option>)}
                      </select>
                      <button type="button" className="link-btn" onClick={() => void addMember()} disabled={!picker}>拉入</button>
                    </span>
                  )}
                </div>
              </div>

              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420 }}>
                {active.messages.length === 0 && <p className="hint" style={{ textAlign: 'center', marginTop: 30 }}>群已建好。发一句话，Agent 们就会依次讨论给你看。</p>}
                {active.messages.map((message) => {
                  if (message.role === 'system') return <div key={message.id} style={{ textAlign: 'center' }}><span className="hint" style={{ fontSize: 11 }}>{message.text}</span></div>;
                  const member = memberOf(message.agentId);
                  const logo = agentLogo(member?.runtime, message.agentId);
                  const isUser = message.role === 'user';
                  return (
                    <div key={message.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', gap: 8 }}>
                      {!isUser && (logo ? <img src={logo} alt="" width={26} height={26} style={{ borderRadius: 7, marginTop: 2 }} /> : <div style={{ width: 26, height: 26, borderRadius: 7, background: '#4f46e5', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{(message.name || 'A').slice(0, 2)}</div>)}
                      <div style={{ maxWidth: '76%' }}>
                        <div className="hint" style={{ fontSize: 10.5, marginBottom: 2, textAlign: isUser ? 'right' : 'left' }}>{message.name} · {new Date(message.at).toLocaleTimeString()}</div>
                        <div style={{ padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: isUser ? '#4f46e5' : '#f4f5fa', color: isUser ? '#fff' : '#1f2937', borderTopRightRadius: isUser ? 3 : 12, borderTopLeftRadius: isUser ? 12 : 3 }}>{message.text}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {canWrite && (
                <div style={{ padding: 12, borderTop: '1px solid var(--line-2)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="在群里指导 Agent…（Enter 发送，Shift+Enter 换行）" rows={2}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
                    style={{ flex: 1, resize: 'vertical', minHeight: 40 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button type="button" className="primary-btn" onClick={() => void send()} disabled={busy || !text.trim()}>发送</button>
                    <button type="button" className="ghost-btn" onClick={() => void discussNow()} disabled={busy || !active.members.length}>让 Agent 讨论</button>
                  </div>
                </div>
              )}
              <label className="hint" style={{ padding: '0 12px 10px', fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={discussOnSend} onChange={(event) => setDiscussOnSend(event.target.checked)} /> 发送后自动让 Agent 依次讨论
              </label>
            </>
          ) : (
            <div className="empty-card" style={{ margin: 'auto', padding: 40 }}>
              <h3>还没有协作群</h3>
              <p>点右上「新建群（拉全部 Agent）」，把 DSH / Codex / Claude 等 Agent 拉进同一个群。</p>
            </div>
          )}
        </div>
      </div>
      {menu && canWrite && (() => {
        const room = rooms.find((item) => item.roomId === menu.roomId);
        if (!room) return null;
        return (
          <div className="ctx-menu" role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 60 }}
            onClick={(event) => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => startRenameRoom(room)}>重命名</button>
            <button type="button" role="menuitem" className="danger" onClick={() => removeRoom(room.roomId, room.title)}>解散群</button>
          </div>
        );
      })()}
      <p className="hint" style={{ fontSize: 11 }}>说明：当前 Agent 发言为离线 fixture（按角色模拟讨论内容，用于打通流程与界面）；接真实模型只需替换服务端 responder，群与消息契约不变。</p>
    </section>
  );
}
