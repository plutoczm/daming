// 真实原厂供应商品牌 SVG（下载自 simple-icons / lobehub，本地托管于 public/logos）。
// 只做「provider id → logo 资源」的归一映射；找不到时由调用方回退到彩色字母徽标。
const LOGOS: Record<string, string> = {
  deepseek: '/logos/deepseek.svg',
  anthropic: '/logos/anthropic.svg',
  claude: '/logos/anthropic.svg',
  openai: '/logos/openai.svg',
  gemini: '/logos/gemini.svg',
  ollama: '/logos/ollama.svg',
  mistral: '/logos/mistral.svg',
  groq: '/logos/groq.svg',
  xai: '/logos/xai.svg',
  baidu: '/logos/baidu.svg',
  qwen: '/logos/qwen.svg',
  alibaba: '/logos/alibaba.svg',
  tencent: '/logos/tencent.svg',
  aws: '/logos/aws.svg',
  meta: '/logos/meta.svg',
  huggingface: '/logos/huggingface.svg',
  microsoft: '/logos/microsoft.svg',
  nvidia: '/logos/nvidia.svg',
  cohere: '/logos/cohere.svg',
  perplexity: '/logos/perplexity.svg',
  bytedance: '/logos/bytedance.svg',
  zhipu: '/logos/zhipu.svg',
  kimi: '/logos/kimi.svg',
  minimax: '/logos/minimax.svg',
  stepfun: '/logos/stepfun.svg'
};

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/deepseek/, 'deepseek'],
  [/anthropic|claude/, 'anthropic'],
  [/openai|codex|chatgpt|\bgpt/, 'openai'],
  [/gemini|google/, 'gemini'],
  [/ollama/, 'ollama'],
  [/mistral/, 'mistral'],
  [/groq/, 'groq'],
  [/xai|grok|^x$/, 'xai'],
  [/baidu|qianfan|ernie/, 'baidu'],
  [/qwen|bailian|dashscope|tongyi/, 'qwen'],
  [/alibaba|aliyun/, 'alibaba'],
  [/tencent|workbuddy|codebuddy|hunyuan|wechat|weixin|\bqq\b|copilot\.tencent/, 'tencent'],
  [/kiro|\baws\b|amazon|bedrock/, 'aws'],
  [/meta|llama/, 'meta'],
  [/huggingface|hugging_face|\bhf\b/, 'huggingface'],
  [/microsoft|azure/, 'microsoft'],
  [/nvidia/, 'nvidia'],
  [/cohere/, 'cohere'],
  [/perplexity/, 'perplexity'],
  [/bytedance|doubao|volcengine|volc|\bark\b/, 'bytedance'],
  [/zhipu|\bglm|bigmodel|\bz\.?ai\b|zcode/, 'zhipu'],
  [/kimi|moonshot/, 'kimi'],
  [/minimax/, 'minimax'],
  [/stepfun|step-?fun/, 'stepfun']
];

/** provider / 模型 / 账号名 → 原厂 logo 资源路径（找不到返回 undefined）。 */
export function providerLogo(...candidates: (string | undefined)[]): string | undefined {
  const text = candidates.filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return undefined;
  for (const [pattern, key] of RULES) if (pattern.test(text)) return LOGOS[key];
  return undefined;
}

/** Agent runtime/agentId → 该 Harness 背后厂商的 logo（DSH=DeepSeek、Codex=OpenAI、Claude=Anthropic）。 */
export function agentLogo(runtime?: string, agentId?: string): string | undefined {
  const text = ((runtime || '') + ' ' + (agentId || '')).toLowerCase();
  if (text.includes('dsh') || text.includes('deepseek')) return LOGOS.deepseek;
  if (text.includes('codex') || text.includes('openai')) return LOGOS.openai;
  if (text.includes('claude') || text.includes('anthropic')) return LOGOS.anthropic;
  if (text.includes('gemini')) return LOGOS.gemini;
  if (text.includes('qwen')) return LOGOS.qwen;
  return undefined;
}
