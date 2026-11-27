/**
 * 网关出站脱敏（服务内自带一份，避免 service→app 依赖）。
 * 与 apps/server/src/secret-mask.ts 同规则；对请求体文本脱敏、对响应体文本还原。
 */
export interface MaskResult { readonly masked: string; readonly findings: readonly { placeholder: string; label: string; sample: string }[]; readonly mapping: Readonly<Record<string, string>>; }

const RULES: readonly { label: string; re: RegExp }[] = [
  { label: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai_key', re: /sk-[A-Za-z0-9]{20,}/g },
  { label: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { label: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { label: 'bearer_token', re: /\bBearer\s+([A-Za-z0-9._\-]{16,})/g },
  { label: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: 'kv_secret', re: /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd)\b\s*[:=]\s*["']?([A-Za-z0-9._\-]{12,})["']?/gi },
];

export function maskText(text: string): MaskResult {
  if (typeof text !== 'string') return { masked: '', findings: [], mapping: {} };
  const mapping: Record<string, string> = {};
  const findings: { placeholder: string; label: string; sample: string }[] = [];
  let masked = text; let counter = 0;
  for (const rule of RULES) {
    masked = masked.replace(rule.re, (match: string, ...groups: unknown[]) => {
      const captured = typeof groups[0] === 'string' && groups[0] ? (groups[0] as string) : match;
      const secret = captured;
      const existing = Object.keys(mapping).find((ph) => mapping[ph] === secret);
      if (existing) return match === secret ? existing : match.split(secret).join(existing);
      counter += 1;
      const placeholder = '{{SECRET_' + counter.toString(16).padStart(4, '0') + '}}';
      mapping[placeholder] = secret;
      findings.push({ placeholder, label: rule.label, sample: rule.label + ': ' + secret.slice(0, 3) + '**** (len ' + secret.length + ')' });
      return match === secret ? placeholder : match.split(secret).join(placeholder);
    });
  }
  return { masked, findings, mapping };
}

export function unmaskText(masked: string, mapping: Readonly<Record<string, string>>): string {
  if (typeof masked !== 'string' || !mapping) return masked;
  let out = masked;
  for (const [placeholder, original] of Object.entries(mapping)) out = out.split(placeholder).join(original);
  return out;
}
