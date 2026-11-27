import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { windowsApprovalScript, requestWindowsNativeApproval } from '../src/windows-approval.ts';
import { currentWindowsSid } from '../src/windows-private-acl.ts';

test('Windows native consent PowerShell parses correctly without displaying a dialog', () => {
  if (process.platform !== 'win32') return;
  const verifier = [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '$tokens=$null',
    '$errors=$null',
    '[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors)|Out-Null',
    '[Console]::Out.Write($errors.Count)'
  ].join('\n');
  const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(verifier, 'utf16le').toString('base64')], {
    input: windowsApprovalScript(), encoding: 'utf8', windowsHide: true, timeout: 12000
  });
  assert.equal(output.status, 0);
  assert.equal(output.stdout.trim(), '0');
});

test('Windows native consent rejects a different OS identity before any UI is shown', async () => {
  if (process.platform !== 'win32') return;
  const sid = currentWindowsSid();
  assert.match(sid, /^S-[0-9-]+$/);
  assert.equal(await requestWindowsNativeApproval({
    operationId: 'test-action', action: 'plugin-update', expectedSid: 'S-1-0-0'
  }), false);
});
