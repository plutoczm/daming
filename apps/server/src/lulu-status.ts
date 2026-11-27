import type { LuluStatusView } from '@daming/contracts';
import { LuluConnector } from '@daming/connectors-lulu';

export interface LuluStatusProvider {
  status(): Promise<LuluStatusView>;
}

function disabled(reason: string): LuluStatusView {
  return {
    enabled: false, health: 'unknown', capabilities: 'disabled',
    checkedAt: new Date().toISOString(), reason
  };
}

export function createLuluStatusProvider(env: Record<string, string | undefined> = process.env): LuluStatusProvider {
  const baseUrl = env.DAMING_LULU_BASE_URL?.trim();
  const sessionCookie = env.DAMING_LULU_SESSION?.trim();
  if (!baseUrl || !sessionCookie) return { status: async () => disabled('not_configured') };
  let connector: LuluConnector;
  try {
    connector = new LuluConnector({ baseUrl, sessionCookie, timeoutMs: 2000 });
  } catch {
    return { status: async () => disabled('invalid_configuration') };
  }
  return {
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
    }
  };
}
