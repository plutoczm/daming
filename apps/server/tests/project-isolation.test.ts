import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectLiveIsolationGate, WSL_BWRAP_ARGS } from '../src/project-isolation.ts';

test('offline WSL sandbox spec isolates user, mounts, network, process tree and environment', () => {
  const args = [...WSL_BWRAP_ARGS];
  assert.ok(args.includes('--unshare-user'));
  assert.ok(args.includes('--unshare-pid'));
  assert.ok(args.includes('--unshare-net'));
  assert.ok(args.includes('--unshare-ipc'));
  assert.ok(args.includes('--unshare-cgroup'));
  assert.ok(args.includes('--die-with-parent'));
  assert.ok(args.includes('--clearenv'));
  assert.ok(args.includes('--ro-bind'));
  assert.ok(args.includes('--tmpfs'));
  assert.ok(args.includes('--new-session'));
  for (const forbidden of ['/mnt/c', '/mnt/d', '/home', 'C:\\', 'D:\\', '--share-net', '--bind']) {
    assert.equal(args.includes(forbidden), false);
  }
  assert.equal(args.at(-3), '/usr/bin/python3');
  assert.equal(args.at(-2), '-c');
  assert.match(args.at(-1)!, /networkBlocked/);
});

test('passing offline namespace proof never bypasses the missing isolated real model launcher', () => {
  const gate = projectLiveIsolationGate();
  assert.deepEqual(gate, { ready: false, reason: 'isolated_model_cli_not_integrated' });
});
