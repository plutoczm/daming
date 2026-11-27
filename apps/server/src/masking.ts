import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Outbound masking (脱敏) — the Daming-side analogue of Magpie's Settings → Privacy
 * masker. Every prompt Daming itself forwards to an Agent/LLM through its own gateway
 * is scrubbed here first: secrets, personal data and user-defined words are replaced
 * with placeholders before the bytes leave this machine. The live Magpie engine keeps
 * its own masking rules on its provider egress; this module covers the paths Daming
 * controls (pipeline real-model executor / preview), so the two layers stay separate.
 */
export interface MaskingSettings {
  readonly enabled: boolean;
  readonly maskSecrets: boolean;
  readonly maskPersonal: boolean;
  readonly keepFormat: boolean;
  readonly customWords: readonly string[];
  readonly exemptProviders: readonly string[];
}

export interface MaskingHit { readonly type: string; readonly sample: string }
export interface MaskingResult { readonly masked: string; readonly hits: readonly MaskingHit[] }

export const DEFAULT_MASKING: MaskingSettings = {
  enabled: true,
  maskSecrets: true,
  maskPersonal: true,
  keepFormat: true,
  customWords: [],
  exemptProviders: ['ollama'],
};

export class MaskingStore {
  private readonly file: string;
  private cached: MaskingSettings;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'masking.json');
    this.cached = this.read();
  }
  private read(): MaskingSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_MASKING };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MaskingSettings>;
      return {
        enabled: raw.enabled ?? DEFAULT_MASKING.enabled,
        maskSecrets: raw.maskSecrets ?? DEFAULT_MASKING.maskSecrets,
        maskPersonal: raw.maskPersonal ?? DEFAULT_MASKING.maskPersonal,
        keepFormat: raw.keepFormat ?? DEFAULT_MASKING.keepFormat,
        customWords: Array.isArray(raw.customWords) ? raw.customWords.filter((word) => typeof word === 'string') : [],
        exemptProviders: Array.isArray(raw.exemptProviders) ? raw.exemptProviders.filter((id) => typeof id === 'string') : [...DEFAULT_MASKING.exemptProviders],
      };
    } catch { return { ...DEFAULT_MASKING }; }
  }
  get(): MaskingSettings { return this.cached; }
  update(patch: Record<string, unknown>): MaskingSettings {
    const next: MaskingSettings = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : this.cached.enabled,
      maskSecrets: typeof patch.maskSecrets === 'boolean' ? patch.maskSecrets : this.cached.maskSecrets,
      maskPersonal: typeof patch.maskPersonal === 'boolean' ? patch.maskPersonal : this.cached.maskPersonal,
      keepFormat: typeof patch.keepFormat === 'boolean' ? patch.keepFormat : this.cached.keepFormat,
      customWords: Array.isArray(patch.customWords) ? patch.customWords.filter((word) => typeof word === 'string' && word.trim()).map((word) => word.trim()) : this.cached.customWords,
      exemptProviders: Array.isArray(patch.exemptProviders) ? patch.exemptProviders.filter((id) => typeof id === 'string') : this.cached.exemptProviders,
    };
    this.cached = next;
    writeFileSync(this.file, JSON.stringify(next, null, 2), { encoding: 'utf8' });
    return next;
  }
}

function maskValue(value: string, keepFormat: boolean): string {
  if (!keepFormat) return '〔已脱敏〕';
  const base = value.length <= 4 ? '*'.repeat(Math.max(value.length, 4)) : value.slice(0, 2) + '*'.repeat(Math.max(value.length - 4, 4)) + value.slice(-2);
  return base;
}

const SECRET_RULES: Array<{ type: string; re: RegExp }> = [
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'api_key', re: /\b(?:sk|pk|ak|rk|ghp|gho|xoxb|xoxp|AIza)[-_A-Za-z0-9]{12,}\b/g },
  { type: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g },
  { type: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'kv_secret', re: /\b(?:password|passwd|pwd|secret|token|apikey|api_key|access_key)\b\s*[:=]\s*["']?[^\s"']{6,}["']?/gi },
];

const PERSONAL_RULES: Array<{ type: string; re: RegExp }> = [
  { type: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'phone_cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { type: 'id_card_cn', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { type: 'bank_card', re: /(?<!\d)(?:\d{4}[ ]?){3}\d{4}(?!\d)/g },
];

export function maskText(text: string, settings: MaskingSettings): MaskingResult {
  if (!settings.enabled || !text) return { masked: text, hits: [] };
  let masked = text;
  const hits: MaskingHit[] = [];
  const apply = (rules: Array<{ type: string; re: RegExp }>) => {
    for (const rule of rules) {
      masked = masked.replace(rule.re, (match) => {
        hits.push({ type: rule.type, sample: match.slice(0, 6) + (match.length > 6 ? '…' : '') });
        return maskValue(match, settings.keepFormat);
      });
    }
  };
  if (settings.maskSecrets) apply(SECRET_RULES);
  if (settings.maskPersonal) apply(PERSONAL_RULES);
  for (const word of settings.customWords) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    masked = masked.replace(re, () => { hits.push({ type: 'custom', sample: word.slice(0, 6) }); return '〔已脱敏〕'; });
  }
  return { masked, hits };
}
