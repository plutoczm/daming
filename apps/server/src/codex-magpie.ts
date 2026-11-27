import { CodexExecRun, createCodexModelConnection } from '@daming/worker-process';
import type { CodexExecOptions, CodexExecResult } from '@daming/worker-process';
import type { MagpieHost, MagpiePinnedBinding } from './magpie-host.ts';

/** Host-only protocol connection, not a production dispatch authorization.
 * The existing paid/isolation gates must be satisfied before invoking it with
 * real accounts. No UI/AutoLoop/Worker registry automatically enables it.
 */
export async function runCodexMagpieTurn(host: MagpieHost, binding: MagpiePinnedBinding,
  options: Pick<CodexExecOptions, 'executable' | 'cwd' | 'prompt' | 'timeoutMs' | 'signal' | 'sandbox' | 'enableShell'>): Promise<CodexExecResult> {
  if (!host.withPinnedModel) throw new Error('magpie_owned_scoped_model_required');
  return host.withPinnedModel(binding, async forward => {
    const connection = await createCodexModelConnection(binding.providerId + '/' + binding.modelId, forward);
    try { return await new CodexExecRun({ ...options, connection }).run(); }
    finally { await connection.close(); }
  });
}
