import type { NativeHandshake } from './native-session.ts';
import { isProtocolRecord } from './native-session.ts';

export const dshHandshake: NativeHandshake = {
  protocol: 'acp',
  entrypoint: '/bin/sh',
  args: ['-ec', 'mkdir -p "$DSH_HOME"; exec dsh --profile acp'],
  input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'daming', version: '1' } },
  }),
  matches: ({ id, result }) => id === 1 && isProtocolRecord(result) && result.protocolVersion === 1 &&
    isProtocolRecord(result.agentInfo) && typeof result.agentInfo.name === 'string' &&
    isProtocolRecord(result.agentCapabilities),
};
