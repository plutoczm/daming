/**
 * 机密脱敏（masking）——对齐 Magpie「请求离开本机前脱敏、回复再还原」。
 * 纯函数、离线；只在本机内存保留原值映射用于还原，不落盘、不联网。
 *
 * 覆盖高置信度机密：API Key（sk-/sk-ant-/AKIA/ghp_ 等）、Bearer Token、私钥块、
 * 以及 key=value / key: value 形式的 api_key/token/secret/password。
 */
export interface MaskFinding {
  readonly placeholder: string;
  readonly label: string;
  readonly sample: string; // 已遮蔽的样例（不回显原值）
}
export interface MaskResult {
  readonly masked: string;
  readonly findings: readonly MaskFinding[];
  readonly mapping: Readonly<Record<string, string>>; // placeholder -> 原值（仅供本机还原）
}

const RULES: readonly { label: string; re: RegExp }[] = [
  { label: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai_key', re: /sk-[A-Za-z0-9]{20,}/g },
  { label: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { label: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { label: 'bearer_token', re: /\bBearer\s+([A-Za-z0-9._\-]{16,})/g },
  { label: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: 'kv_secret', re: /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd)\b\s*[:=]\s*["']?([A-Za-z0-9._\-]{12,})["']?/gi },
];

function labelSample(label: string, value: string): string {
  const head = value.slice(0, 3);
  return `${label}: ${head}**** (len ${value.length})`;
}

/** 对一段文本做脱敏；相同原值复用同一占位符。 */
export function maskText(text: string): MaskResult {
  if (typeof text !== 'string') return { masked: '', findings: [], mapping: {} };
  const mapping: Record<string, string> = {};
  const order: MaskFinding[] = [];
  let masked = text;
  let counter = 0;
  for (const rule of RULES) {
    // 逐规则在“当前已脱敏文本”上再扫（避免重复命中已替换内容）
    masked = masked.replace(rule.re, (match: string, ...groups: unknown[]) => {
      // kv_secret/bearer 的捕获组是真正机密，其余整段即机密
      const captured = typeof groups[0] === 'string' && groups[0] ? groups[0] as string : match;
      const secret = captured;
      const existing = Object.keys(mapping).find((ph) => mapping[ph] === secret);
      if (existing) {
        // 若整段命中里包含捕获组，用占位符替换捕获组那一段
        return match === secret ? existing : match.split(secret).join(existing);
      }
      counter += 1;
      const placeholder = `{{SECRET_${counter.toString(16).padStart(4, '0')}}}`;
      mapping[placeholder] = secret;
      order.push({ placeholder, label: rule.label, sample: labelSample(rule.label, secret) });
      return match === secret ? placeholder : match.split(secret).join(placeholder);
    });
  }
  return { masked, findings: order, mapping };
}

/** 用 mapping 把占位符还原（例如模型回复里出现占位符时）。 */
export function unmaskText(masked: string, mapping: Readonly<Record<string, string>>): string {
  if (typeof masked !== 'string') return '';
  let out = masked;
  for (const [placeholder, original] of Object.entries(mapping)) {
    out = out.split(placeholder).join(original);
  }
  return out;
}
