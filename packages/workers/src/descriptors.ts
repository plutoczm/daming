export type ExecutorKind='dsh'|'codex'|'claude-code'|'local';
export interface WorkerDescriptor {
  id:string;executorKind:ExecutorKind;executionMode:'fixture'|'real'|'unavailable';runtime:string;
  provider:string;model:string;routeMode:'native'|'magpie';gatewayVerified?:boolean;
  os:'win32'|'linux'|'darwin';health:'ready'|'unavailable';credentialsReady:boolean;
  capabilities:readonly string[];permissions:readonly string[];network:'offline'|'internet';dataScopes:readonly string[];
  maxCashMinor:number|null;priceVerified:boolean;quotaRemaining:number;concurrencyLimit:number;activeCount:number;
  /** Real workers only: how the Host settles cash. Defaults to subscription (zero marginal cash). */
  billingSource?:'subscription'|'official_api'|'local';
  isolation:'fixture_only'|'supervised'|'enforced';
  metrics?:{samples:number;successes:number;latencyMs:number};
}
export interface RoutingRequest {
  os:WorkerDescriptor['os'];provider:string;model?:string;routeMode:WorkerDescriptor['routeMode'];
  capabilities:readonly string[];permissions:readonly string[];network:WorkerDescriptor['network'];dataScope:string;
  maxCashMinor:number;allowFixture:boolean;allowReal?:boolean;
}
