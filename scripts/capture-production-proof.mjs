/**
 * Non-billing, non-invasive machine observation. It never reads API keys,
 * starts Magpie or sends a model request, and it does not grant production
 * capabilities. Run from the repository root:
 *   node scripts/capture-production-proof.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeTenantDockerAgent } from '../apps/server/src/tenant-docker-sandbox.ts';

const now = new Date();
const result = {
  schemaVersion: 1,
  purpose: 'non_spending_machine_observation_only',
  observedAt: now.toISOString(),
  docker: { status: 'unavailable', realIsolationObserved: false },
  magpie: { status: 'unavailable', portsInspected: [3425,3457],
    nativePatchedScopeVerified: false, subscriptionOwnerVerified: false },
  scope: 'local_process_only_not_attached_host_session',
  paidAgentDispatchApproved: false,
  authoritativePerRequestVendorInvoiceVerified: false,
  exactPerRequestCashLimitVerified: false,
  subscriptionAccountTenantEntitlementVerified: false,
  realPaidModelRequestsMade: 0,
  officialBillingEndpointsQueried: 0,
  modelCredentialsLoaded: false
};
try {
  const isolated = await probeTenantDockerAgent('Daming production evidence: offline container', {
    timeoutMs: 15000
  });
  result.docker = { status: 'real_docker_container_verified',
    realIsolationObserved: isolated.containerIsolated &&
      isolated.networkBlocked && isolated.hostSecretsHidden &&
      isolated.rootReadonly && isolated.unprivileged &&
      isolated.windowsDrivesHidden && !isolated.credentialsInjected,
    runtime: isolated.runtime,
    networkBlocked: isolated.networkBlocked,
    hostSecretsHidden: isolated.hostSecretsHidden,
    filesystemReadonly: isolated.rootReadonly,
    windowsDrivesHidden: isolated.windowsDrivesHidden,
    unprivileged: isolated.unprivileged
  };
} catch (error) {
  result.docker = {
    status: 'probe_failed_without_external_model_request',
    realIsolationObserved: false,
    reason: error instanceof Error ? error.message.slice(0, 100) : 'unavailable'
  };
}
const probes = [];
for (const port of [3425,3457]) {
  try {
    const greeting = await fetch('http://127.0.0.1:' + port + '/api/hello', {
      signal: AbortSignal.timeout(1500),
      redirect: 'error'
    });
    if (greeting.ok && (greeting.headers.get('content-type') ?? '').includes('json')) {
      const payload = await greeting.json();
      probes.push({ port, compatibleHello: payload?.name === 'magpie' });
    } else probes.push({ port, compatibleHello: false });
  } catch { probes.push({ port, compatibleHello: false }); }
}
result.magpie = {
  status: probes.some(p => p.compatibleHello) ? 'hello_observed_only' : 'no_hello_at_known_ports',
  portsInspected: [3425,3457],
  probes, nativePatchedScopeVerified: false,
  subscriptionOwnerVerified: false
};
// No credentials or upstream access exist in this script: a Magpie /api/hello
// is NOT an account/session attestation or production gateway scope proof.
const output = resolve('.cache/verification/production-environment-2026-11-13.json');
mkdirSync(resolve('.cache/verification'), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'w' });
console.log('PRODUCTION_MACHINE_OBSERVATION=' + JSON.stringify({
  file: '.cache/verification/production-environment-2026-11-13.json',
  dockerRealIsolation: result.docker.realIsolationObserved,
  magpieHelloFound: probes.some(p => p.compatibleHello),
  productionApproved: false,
  billedModelCalls: 0
}));
if (!result.docker.realIsolationObserved) process.exitCode = 2;

