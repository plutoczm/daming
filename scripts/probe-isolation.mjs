import { probeOfflineWslIsolation, projectLiveIsolationGate } from '../apps/server/src/project-isolation.ts';

const offline = await probeOfflineWslIsolation();
const live = projectLiveIsolationGate();
console.log('ISOLATION_PROBE=' + JSON.stringify({
  ...offline,
  liveAgentReady: live.ready,
  liveAgentReason: live.reason,
  noUserFilesRead: true,
  noModelOrVendorCall: true
}));
if (!offline.available) process.exitCode = 2;
