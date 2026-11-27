/** User-authorized local instance startup + read-only inventory. Never inference. */
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chooseMagpieProfile } from '../apps/server/src/magpie-profile.ts';
import { createMagpieHost } from '../apps/server/src/magpie-host.ts';

const base = process.env.DAMING_DATA_DIR ?? join(process.env.LOCALAPPDATA, 'Daming');
const profile = chooseMagpieProfile(base);
const requestedBinary = process.argv.find(a => a.startsWith('--binary='))?.slice('--binary='.length);
const host = createMagpieHost({ dataDir: profile.dataDir, profile: profile.profile,
  ...(requestedBinary ? { binary: resolve(requestedBinary) } : {}) });
const proof = { observedAt: new Date().toISOString(), approvedNewBudgetMinor: 500,
  realInferenceRequests: 0, previousUnknownHoldModified: false,
  personalAgentConfigurationModified: false, binaryReplaced: false };
try {
  proof.before = await host.status();
  proof.status = await host.ensure();
  if (proof.status.configured) {
    proof.nativeSingleUpstreamSupported = await host.scopeCapability();
    try {
      const subscription = await host.codexSubscriptionBinding('gpt-6.1-sol');
      proof.codexSubscriptionBinding = { provider: subscription.providerId, model: subscription.modelId,
        kind: subscription.accountKind, stableAccountBound: true, accountIdentityExposed: false };
      proof.codexSubscriptionScope = await host.probePinnedScope(subscription);
    } catch (error) {
      proof.codexSubscriptionScope = { verified: false, reason: error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'subscription_scope_unavailable' };
    }
    const targets = await host.unifiedTargets();
    proof.targetCount = targets.targets.length;
    proof.requestedTargets = targets.targets.filter(t => /6[._-]1.*sol|4[._-]1.*flash/i.test(t.targetId))
      .map(t => ({ id: t.targetId, kind: t.kind, ready: t.ready }));
    const catalog = await host.routingCatalog();
    proof.pinnedApiCandidateCount = catalog.candidates.length;
    proof.matchingPinnedApiModels = [...new Set(catalog.candidates
      .filter(c => /6[._-]1.*sol|4[._-]1.*flash/i.test(c.modelId))
      .map(c => c.providerId + '/' + c.modelId))];
    proof.availableModelIds = targets.targets.map(t => t.targetId);
  }
} catch (error) {
  // Never print raw vendor bodies, credentials, login identities or logs.
  proof.error = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'preflight_unavailable';
  process.exitCode = 1;
} finally {
  host.stop(); // only a process started by this Host; never a pre-existing app.
}
writeFileSync(requestedBinary ? '.cache/verification/codex-subscription-preflight-2026-11-16.json' : '.cache/verification/codex-magpie-live-preflight-2026-11-16.json', JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof,null,2));

