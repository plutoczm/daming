import { spawnSync } from 'node:child_process';

/**
 * Windows DPAPI user-scope encryption. The secret is transferred only over
 * stdin/stdout of a short-lived local PowerShell process; never command-line args.
 * No plaintext fallback on Windows: an unavailable DPAPI means fail closed.
 */
export class WindowsSecretError extends Error {}

function invoke(mode: 'protect' | 'unprotect', input: string): string {
  if (process.platform !== 'win32') throw new WindowsSecretError('dpapi_windows_only');
  if (typeof input !== 'string' || !input || input.length > 4096) throw new WindowsSecretError('dpapi_input_invalid');
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Security',
    '$source=[Console]::In.ReadToEnd()',
    "if($env:DAMING_DPAPI_MODE -eq 'protect') {",
    '  $bytes=[Text.Encoding]::UTF8.GetBytes($source)',
    '  $sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '  [Console]::Out.Write([Convert]::ToBase64String($sealed))',
    '} else {',
    '  $bytes=[Convert]::FromBase64String($source)',
    '  $clear=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))',
    '}'
  ].join('\n');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    input, encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024,
    env: { ...process.env, DAMING_DPAPI_MODE: mode }
  });
  if (output.error || output.status !== 0 || !output.stdout) throw new WindowsSecretError('dpapi_unavailable');
  return output.stdout.trim();
}

export function protectWindowsSecret(value: string): string {
  return invoke('protect', value);
}

export function unprotectWindowsSecret(value: string): string {
  if (!/^[A-Za-z0-9+/=]{20,8192}$/.test(value)) throw new WindowsSecretError('dpapi_payload_invalid');
  return invoke('unprotect', value);
}
