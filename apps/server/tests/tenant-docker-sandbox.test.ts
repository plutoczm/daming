import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOCKER_AGENT_ISOLATION_ARGS, probeTenantDockerAgent
} from '../src/tenant-docker-sandbox.ts';

test('paid Agent Docker boundary requires fixed local daemon and no host resources', async () => {
  const args = DOCKER_AGENT_ISOLATION_ARGS.join(' ');
  for (const expected of [
    'npipe:////./pipe/dockerDesktopLinuxEngine', '--pull=never',
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--user=65534:65534', '--pids-limit=32', '--memory=128m',
    '--memory-swap=128m', '--cpus=0.5', '--tmpfs=/tmp:'
  ]) assert.ok(args.includes(expected), expected);
  for (const forbidden of ['--privileged','--volume','--mount','--network=host',
    '/var/run/docker.sock', '/mnt/c', 'DEEPSEEK_API_KEY','OPENAI_API_KEY',
    '--publish', '--env-file']) assert.equal(args.includes(forbidden), false, forbidden);
  await assert.rejects(probeTenantDockerAgent('a'.repeat(2049)),
    /docker_agent_input_invalid/);
  await assert.rejects(probeTenantDockerAgent('x', { timeoutMs: 30 }),
    /docker_agent_timeout_invalid/);
});

const live = process.platform === 'win32' &&
  process.env.DAMING_VALIDATE_DOCKER_AGENT === '1';
test('real Docker Desktop container proves no network, secrets, root writes or privileges', {
  skip: live ? false : 'opt-in by DAMING_VALIDATE_DOCKER_AGENT=1 on Windows'
}, async () => {
  // Never load project .env or user model credentials for this test.
  const proof = await probeTenantDockerAgent('离线 agent\nsecond line', { timeoutMs: 30000 });
  assert.equal(proof.runtime, 'docker-desktop-linux');
  assert.equal(proof.containerIsolated, true);
  assert.equal(proof.networkBlocked, true);
  assert.equal(proof.rootReadonly, true);
  assert.equal(proof.tempWritable, true);
  assert.equal(proof.hostSecretsHidden, true);
  assert.equal(proof.windowsDrivesHidden, true);
  assert.equal(proof.unprivileged, true);
  assert.equal(proof.paidDispatchPermitted, false);
  assert.equal(proof.modelCallsEnabled, false);
  assert.equal(proof.credentialsInjected, false);
  assert.equal(proof.externalToolsEnabled, false);
  assert.equal(proof.lineCount, 2);
});
