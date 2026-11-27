import { randomBytes, randomUUID } from 'node:crypto';
import type { LuluStatusView } from '@daming/contracts';
import { LuluConnector, createLuluApproval } from '@daming/connectors-lulu';
import type { LuluSubmission, LuluSubmitInput } from '@daming/connectors-lulu';
import { FileLuluRunStore } from './lulu-run-store.ts';
import type { LuluRunRecord } from '@daming/connectors-lulu';

export interface LuluService {
  readonly enabled: boolean;
  status(): Promise<LuluStatusView>;
  submit(input: { platform: string; conversationId: string; message: string; sender?: string }): Promise<LuluSubmission>;
  run(runId: string): LuluRunRecord | undefined;
}

function disabled(reason: string): LuluStatusView {
  return { enabled: false, health: 'unknown', capabilities: 'disabled', checkedAt: new Date().toISOString(), reason };
}

export function createLuluService(
  env: Record<string, string | undefined> = process.env,
  options: { readonly runStorePath: string; readonly now?: () => number }
): LuluService {
  const baseUrl = env.DAMING_LULU_BASE_URL?.trim();
  const sessionCookie = env.DAMING_LULU_SESSION?.trim();
  if (!baseUrl || !sessionCookie) {
    return {
      enabled: false,
      status: async () => disabled('not_configured'),
      submit: async () => ({ status: 'rejected', reason: 'not_configured' }),
      run: () => undefined
    };
  }
  let connector: LuluConnector;
  let approvalSecret: string;
  let runStore: FileLuluRunStore;
  try {
    approvalSecret = env.DAMING_LULU_APPROVAL_SECRET?.trim() || randomBytes(32).toString('hex');
    runStore = new FileLuluRunStore(options.runStorePath);
    connector = new LuluConnector({
      baseUrl, sessionCookie, timeoutMs: 8000, approvalSecret, runStore,
      ...(options.now ? { now: options.now } : {})
    });
  } catch {
    return {
      enabled: false,
      status: async () => disabled('invalid_configuration'),
      submit: async () => ({ status: 'rejected', reason: 'invalid_configuration' }),
      run: () => undefined
    };
  }
  return {
    enabled: true,
    async status() {
      try {
        const checkedAt = new Date().toISOString();
        const [health, capabilities] = await Promise.all([connector.health(), connector.capabilities()]);
        return {
          enabled: true,
          health: health.status,
          capabilities: capabilities.status,
          checkedAt,
          ...(capabilities.coachPrimary === undefined ? {} : { coachPrimary: capabilities.coachPrimary }),
          ...(capabilities.agentPrimary === undefined ? {} : { agentPrimary: capabilities.agentPrimary }),
          ...(capabilities.fastModel === undefined ? {} : { fastModel: capabilities.fastModel }),
          ...(capabilities.memoryModel === undefined ? {} : { memoryModel: capabilities.memoryModel }),
          ...(health.reason ?? capabilities.reason ? { reason: health.reason ?? capabilities.reason } : {})
        };
      } catch {
        return { enabled: true, health: 'unavailable', capabilities: 'unavailable', checkedAt: new Date().toISOString(), reason: 'status_check_failed' };
      }
    },
    async submit(input) {
      const request: LuluSubmitInput = {
        platform: input.platform,
        conversationId: input.conversationId,
        messages: [{ sender: input.sender?.trim() || 'user', text: input.message }]
      };
      const nonce = randomUUID();
      const approval = createLuluApproval(request, {
        taskId: `lulu-ui-${nonce}`,
        target: connector.baseUrl,
        expiresAtMs: (options.now?.() ?? Date.now()) + 60_000,
        nonce,
        secret: approvalSecret
      });
      return await connector.submit(request, approval);
    },
    run(runId) {
      return runStore.get(runId);
    }
  };
}
