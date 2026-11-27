import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentConfig, writeAgentConfigs } from '../src/onboarding.ts';

const ep = { openaiBaseUrl: 'http://127.0.0.1:9999', anthropicBaseUrl: 'http://127.0.0.1:9999', apiKey: 'k-1', model: 'qwen3:8b' };

test('renderAgentConfig: codex/claude/dsh point at Daming gateway', () => {
  const cx = renderAgentConfig('codex', ep);
  assert.equal(cx.format, 'toml');
  assert.ok(cx.content.includes('base_url = "http://127.0.0.1:9999/v1"') && cx.content.includes('wire_api = "responses"') && cx.content.includes('"qwen3:8b"'));
  const cl = renderAgentConfig('claude', ep);
  assert.ok(cl.content.includes('ANTHROPIC_BASE_URL=http://127.0.0.1:9999') && cl.content.includes('ANTHROPIC_API_KEY=k-1'));
  const dsh = renderAgentConfig('dsh', ep);
  assert.ok(dsh.content.includes('DAMING_GATEWAY_OPENAI_BASE_URL=http://127.0.0.1:9999/v1') && dsh.content.includes('DSH_DEFAULT_MODEL=qwen3:8b'));
});

test('writeAgentConfigs writes only under the target dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'daming-onboarding-'));
  try {
    const files = writeAgentConfigs(['codex', 'claude', 'dsh'], ep, d);
    assert.equal(files.length, 3);
    for (const f of files) assert.ok(readFileSync(join(d, f.path), 'utf8').length > 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
