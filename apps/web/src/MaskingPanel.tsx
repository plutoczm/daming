import { useEffect, useMemo, useState } from 'react';
import type { SessionView } from '@daming/contracts';

interface MaskingSettings {
  enabled: boolean; maskSecrets: boolean; maskPersonal: boolean; keepFormat: boolean;
  customWords: string[]; exemptProviders: string[];
}
interface Hit { type: string; sample: string }
interface InventoryProvider { id: string; name: string }

const HIT_LABEL: Record<string, string> = {
  api_key: 'API Key', private_key: '私钥', bearer: 'Bearer Token', aws_key: 'AWS Key',
  kv_secret: '密码/密钥', email: '邮箱', phone_cn: '手机号', id_card_cn: '身份证', bank_card: '银行卡', custom: '自定义词',
};

/** 脱敏：Daming 独立模块。借鉴 Magpie Settings→Privacy 的规则，把发给各 Agent/LLM 的内容先脱敏再上传。 */
export function MaskingPanel({ session }: { session: SessionView }) {
  const [settings, setSettings] = useState<MaskingSettings | null>(null);
  const [providers, setProviders] = useState<InventoryProvider[]>([]);
  const [wordDraft, setWordDraft] = useState('');
  const [sample, setSample] = useState('我的邮箱 zhangsan@example.com，手机 13800138000，key = sk-abcdef1234567890abcdef');
  const [preview, setPreview] = useState<{ masked: string; hits: Hit[] } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canWrite = session.role === 'readwrite';

  const load = async () => {
    try {
      const [s, inv] = await Promise.all([
        fetch('/api/masking/settings', { credentials: 'same-origin' }),
        fetch('/api/magpie/inventory', { credentials: 'same-origin' })
      ]);
      if (s.ok) { const data = await s.json() as { settings?: MaskingSettings }; if (data.settings) setSettings(data.settings); }
      if (inv.ok) { const data = await inv.json() as { providers?: InventoryProvider[] }; setProviders(data.providers ?? []); }
    } catch { setNote('读取脱敏设置失败'); }
  };
  useEffect(() => { void load(); }, []);

  const save = async (patch: Partial<MaskingSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const response = await fetch('/api/masking/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify(patch)
      });
      const data = await response.json().catch(() => ({})) as { settings?: MaskingSettings };
      if (data.settings) setSettings(data.settings);
      setNote('已保存');
    } catch { setNote('保存失败'); }
  };

  const addWord = () => {
    const word = wordDraft.trim();
    if (!word || !settings) return;
    if (!settings.customWords.includes(word)) void save({ customWords: [...settings.customWords, word] });
    setWordDraft('');
  };
  const removeWord = (word: string) => { if (settings) void save({ customWords: settings.customWords.filter((item) => item !== word) }); };
  const toggleExempt = (id: string) => {
    if (!settings) return;
    const has = settings.exemptProviders.includes(id);
    void save({ exemptProviders: has ? settings.exemptProviders.filter((item) => item !== id) : [...settings.exemptProviders, id] });
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/masking/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ text: sample })
      });
      const data = await response.json() as { masked?: string; hits?: Hit[] };
      setPreview({ masked: data.masked ?? '', hits: data.hits ?? [] });
    } catch { setNote('预览失败'); }
    finally { setBusy(false); }
  };

  const providerName = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers) map.set(provider.id, provider.name || provider.id);
    return map;
  }, [providers]);

  return (
    <section className="page-stack masking-page" aria-label="脱敏">
      <header className="page-head">
        <div>
          <p className="eyebrow">PRIVACY / OUTBOUND MASKING</p>
          <h2>脱敏</h2>
          <p className="hint">把发给各 Agent / LLM 的内容先按规则脱敏再上传：密钥、个人信息、自定义词都会替换成占位符。参考 Magpie 的脱敏规则实现。</p>
        </div>
      </header>
      {note && <p className="hint" role="status">{note}</p>}

      {settings && (
        <div className="status-card" style={{ padding: 16 }}>
          <div className="card-title"><h3>开关</h3><span className="hint">总开关关闭后，任何内容都不脱敏</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 10 }}>
            {([
              ['enabled', '启用脱敏', '各网关上传前统一脱敏'],
              ['maskSecrets', '脱敏密钥', 'API Key / Token / 私钥 / 密码'],
              ['maskPersonal', '脱敏个人信息', '邮箱 / 手机号 / 身份证 / 银行卡'],
              ['keepFormat', '保留密钥格式', '保留首尾字符，中间打码'],
            ] as const).map(([key, label, desc]) => (
              <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: canWrite ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={settings[key]} disabled={!canWrite}
                  onChange={(event) => void save({ [key]: event.target.checked } as Partial<MaskingSettings>)} />
                <span><strong>{label}</strong><br /><span className="hint" style={{ fontSize: 12 }}>{desc}</span></span>
              </label>
            ))}
          </div>
        </div>
      )}

      {settings && (
        <div className="status-card" style={{ padding: 16 }}>
          <div className="card-title"><h3>自定义脱敏词</h3><span className="hint">人名 / 代号 / 主机名，命中即替换为〔已脱敏〕</span></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {settings.customWords.length === 0 && <span className="hint">还没有自定义词</span>}
            {settings.customWords.map((word) => (
              <span className="chip" key={word}>{word}{canWrite && <button type="button" onClick={() => removeWord(word)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#ef4444', marginLeft: 4 }}>✕</button>}</span>
            ))}
          </div>
          {canWrite && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={wordDraft} onChange={(event) => setWordDraft(event.target.value)} placeholder="输入后回车添加" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addWord(); } }} style={{ maxWidth: 320 }} />
              <button type="button" className="ghost-btn" onClick={addWord}>添加</button>
            </div>
          )}
        </div>
      )}

      {settings && (
        <div className="status-card" style={{ padding: 16 }}>
          <div className="card-title"><h3>不脱敏的供应商</h3><span className="hint">勾选的供应商（如本地 ollama）上传时不脱敏</span></div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {providers.length === 0 && <span className="hint">暂无供应商</span>}
            {providers.map((provider) => (
              <label key={provider.id} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: canWrite ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={settings.exemptProviders.includes(provider.id)} disabled={!canWrite}
                  onChange={() => toggleExempt(provider.id)} />
                <span>{providerName.get(provider.id)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>脱敏预览</h3><span className="hint">粘贴文本，看本机脱敏后发给厂商的样子（原值不出本机）</span></div>
        <textarea value={sample} onChange={(event) => setSample(event.target.value)} rows={4} style={{ width: '100%', resize: 'vertical' }} placeholder="粘贴含 API Key / token / 手机号 / 邮箱 / 自定义词的文本" />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button type="button" className="primary-btn" onClick={() => void runPreview()} disabled={busy}>{busy ? '处理中…' : '预览脱敏结果'}</button>
          {preview && preview.hits.length > 0 && (
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {preview.hits.map((hit, index) => <span className="chip" key={index}>{HIT_LABEL[hit.type] ?? hit.type}：{hit.sample}</span>)}
            </span>
          )}
        </div>
        {preview && (
          <pre style={{ marginTop: 10, padding: 12, background: 'var(--surface-2)', borderRadius: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13 }}>{preview.masked}</pre>
        )}
      </div>
    </section>
  );
}
