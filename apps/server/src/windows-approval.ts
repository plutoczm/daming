import { spawn } from 'node:child_process';
import { currentWindowsSid } from './windows-private-acl.ts';

export interface WindowsApprovalRequest {
  readonly operationId: string;
  readonly action: string;
  readonly target?: string;
  readonly expectedSid: string;
}

/**
 * A separate, explicitly accepted Windows desktop consent window.
 * This is local physical/session consent, NOT a substitute for Windows Hello MFA.
 * No URL, CSRF cookie, session token or credential is passed into the dialog.
 */
export function windowsApprovalScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$data=[Console]::In.ReadToEnd() | ConvertFrom-Json',
    'if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $data.expectedSid) { exit 13 }',
    '$form=New-Object System.Windows.Forms.Form',
    "$form.Text='Daming - Windows 本机授权确认'",
    '$form.Width=550',
    '$form.Height=260',
    '$form.FormBorderStyle=[Windows.Forms.FormBorderStyle]::FixedDialog',
    '$form.MaximizeBox=$false',
    '$form.MinimizeBox=$false',
    '$form.StartPosition=[Windows.Forms.FormStartPosition]::CenterScreen',
    '$form.TopMost=$true',
    '$label=New-Object System.Windows.Forms.Label',
    '$label.Left=20',
    '$label.Top=20',
    '$label.Width=490',
    '$label.Height=125',
    "$label.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',11)",
    "$label.Text='你正在授权大铭执行真实操作。请仅在你主动发起操作时批准。' + [Environment]::NewLine + [Environment]::NewLine + $data.action + [Environment]::NewLine + $data.target",
    '$form.Controls.Add($label)',
    '$yes=New-Object System.Windows.Forms.Button',
    "$yes.Text='确认执行'",
    '$yes.DialogResult=[Windows.Forms.DialogResult]::Yes',
    '$yes.Left=295',
    '$yes.Top=160',
    '$yes.Width=100',
    '$form.Controls.Add($yes)',
    '$no=New-Object System.Windows.Forms.Button',
    "$no.Text='拒绝'",
    '$no.DialogResult=[Windows.Forms.DialogResult]::No',
    '$no.Left=405',
    '$no.Top=160',
    '$no.Width=100',
    '$form.Controls.Add($no)',
    '$form.AcceptButton=$yes',
    '$form.CancelButton=$no',
    '$choice=$form.ShowDialog()',
    '$form.Dispose()',
    "if($choice -eq [Windows.Forms.DialogResult]::Yes) {[Console]::Out.Write('APPROVED')} else {[Console]::Out.Write('REJECTED')}"
  ].join('\n');
}

export async function requestWindowsNativeApproval(request: WindowsApprovalRequest): Promise<boolean> {
  if (process.platform !== 'win32' || currentWindowsSid() !== request.expectedSid) return false;
  const script = windowsApprovalScript();
  const command = Buffer.from(script, 'utf16le').toString('base64');
  return await new Promise<boolean>((finish) => {
    let settled = false;
    let stdout = '';
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(value);
    };
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', command], {
      windowsHide: false, stdio: ['pipe', 'pipe', 'ignore']
    });
    const timer = setTimeout(() => { child.kill(); done(false); }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 256) stdout += chunk.toString('utf8');
    });
    child.once('error', () => done(false));
    child.once('close', (code) => done(code === 0 && stdout.trim() === 'APPROVED'));
    child.stdin.on('error', () => done(false));
    child.stdin.end(JSON.stringify({
      expectedSid: request.expectedSid,
      action: request.action,
      target: request.target ?? '(无特定插件)'
    }));
  });
}
