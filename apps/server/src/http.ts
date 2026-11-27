import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import type { ApiErrorView, AutoloopAgentHealthView, AvailableModelView, AvailableModelsView, AutonomyProfileView, CreateMissionInput, CreateMissionRouteAuthorizationInput, PrepareMissionRouteAttemptInput, CreateTaskInput, MissionResourceView, PortfolioDigestView, ProjectPricingView, SessionView, MagpieReadView } from '@daming/contracts';
import { acquireHostLock } from './host-lock.ts';
import { SessionManager, sessionCookie } from './auth.ts';
import type { BootstrapToken, Session } from './auth.ts';
import { createBoardCoordinator, createRealCodexCoordinator, createRealDshCoordinator, createRealClaudeCoordinator, createRealCodexPlan, createRealDshPlan } from './board-fixture.ts';
import { TaskRouteService } from './routes/task-routes.ts';
import { listAvailableModels } from './agent-catalog.ts';
import { ModelBindingError, ModelBindingStore } from './model-binding.ts';
import { ProjectInputError, ProjectInputStore } from './project-input.ts';
import { ProjectWorkbench, ProjectWorkbenchError, type WorkbenchSeed } from './project-workbench.ts';
import { ProjectGit, ProjectGitError } from './project-git.ts';
import { GitAccountStore, normalizeProvider } from './git-account.ts';
import type { PlanStep, SpecClause } from './project-input.ts';
import { NotificationHub } from './notification-hub.ts';
import type { NotificationChannelId, NotificationEvent } from './notification-hub.ts';
import { CrewPlanStore, planCrew } from './crew-planner.ts';
import { simulatePipeline, type PipelineAgent } from './pipeline.ts';
import { attachRoomDiscussions, createAndRunPipeline, PipelineRunStore, reassignAndRerun, rerunPipelineStage, syncPipelineRoom } from './pipeline-runs.ts';
import { createRealPipelineRuntime, gatewayTextPort, type RealPipelineRuntime } from './pipeline-real.ts';
import { MaskingStore, maskText as maskOutboundText } from './masking.ts';
import { AgentRoomStore, discuss as discussRoom, fixtureRoomResponder } from './agent-room.ts';
import type { RoomMember } from './agent-room.ts';
import type { CrewDispatchRecord } from './crew-planner.ts';
import { buildCrewOverview, findCrewContext } from './crew-overview.ts';
import { buildExecutionGraph } from './execution-graph.ts';
import { buildPortfolioDigest, PortfolioGovernanceStore } from './portfolio-governance.ts';
import { projectInputToPortfolioView } from './portfolio-projects.ts';
import { PortfolioNotifyStore, PortfolioNotifier } from './portfolio-notify.ts';
import { PortfolioDecisionStore, PortfolioDecisionError } from './portfolio-decisions.ts';
import { AgentProfileStore, PlatformCatalogError, ProviderStore } from './platform-catalog.ts';
import { RoutingGroupStore, ProfileStore, RoutingError, applyProfile } from './platform-routing.ts';
import { maskText } from './secret-mask.ts';
import { RequestLogStore, contextComposition, GatewayObsError } from './gateway-observability.ts';
import { GatewayServeManager } from './gateway-serve.ts';
import { scanMagpieInventory } from './magpie-inventory.ts';
import { createLuluStatusProvider } from './lulu-status.ts';
import type { LuluStatusProvider } from './lulu-status.ts';
import { createLuluService } from './lulu-service.ts';
import type { LuluService } from './lulu-service.ts';
import { createDeepSeekBalanceService } from './deepseek-balance.ts';
import type { DeepSeekBalanceService } from './deepseek-balance.ts';
import { createAutoloopService } from './autoloop-service.ts';
import type { AutoloopService } from './autoloop-service.ts';
import { createAutoloopJobRunner, runCoordinatorTask } from './autoloop-runner.ts';
import { createMagpieHost } from './magpie-host.ts';
import { createAttachedMagpieHost } from './magpie-attached-host.ts';
import type { MagpieHost } from './magpie-host.ts';
import { MagpieOperationJournal, MagpieOperationError } from './magpie-operations.ts';
import { chooseMagpieProfile } from './magpie-profile.ts';
import { currentWindowsSid, secureNewWindowsDirectory } from './windows-private-acl.ts';
import { IdentityRegistry, IdentityError } from './identity-registry.ts';
import type { ProviderKind, CredentialBinding } from './identity-registry.ts';
import { verifyVendorKeyControl } from './magpie-owner-proof.ts';
import { runIsolatedTenantInspect, TenantSandboxError } from './tenant-sandbox.ts';
import { probeTenantDockerAgent, TenantDockerSandboxError } from './tenant-docker-sandbox.ts';
import { AgentOrchestrator, AgentGraphError } from './agent-orchestrator.ts';
import type { OfflineAgentDriver } from './agent-orchestrator.ts';
import { TenantBudgetLedger, TenantBudgetError } from './tenant-budget.ts';
import { TrustedPaidEgress, TrustedEgressError } from './trusted-paid-egress.ts';
import type { PaidAgentInput, PaidModelTransport, TrustedAgentRunner } from './trusted-paid-egress.ts';
import { TrustedAgentProcessError } from './tenant-paid-agent-runner.ts';
import { planGovernedMagpieTargets } from './magpie-governed-route.ts';
import { GOVERNED_MODEL_TOOLS } from './governed-tool-turns.ts';
import { readOpenAiIssuedKeyDailyCost, OfficialCostEvidenceError } from './official-cost-evidence.ts';
import { readOpenAiSpendLimitState, OfficialSpendLimitError } from './official-spend-limit.ts';
import { evaluateProductionProof } from './production-proof.ts';
import { issueOpenAiProjectServiceKey, OpenAiKeyIssuanceError } from './openai-service-key.ts';
import type { OpenAiAdminTransport } from './openai-service-key.ts';
import { BillingProbeError, probeDeepSeekBalance, probeOpenAiProjectCost } from './vendor-billing-readonly.ts';
import type { OfficialReadTransport } from './vendor-billing-readonly.ts';
import { requestWindowsNativeApproval } from './windows-approval.ts';
import type { WindowsApprovalRequest } from './windows-approval.ts';
import { createCodexProbe } from './codex-probe.ts';
import type { CodexProbeService } from './codex-probe.ts';
import { BoardLiveEvents } from './live-events.ts';
import { MissionControl, MissionError } from './mission-control.ts';
import { publicMagpieRoutingCatalog } from './magpie-routing.ts';
import { validateMagpieRoleAssignments } from './magpie-unified-targets.ts';
import type { MagpieRoutingCatalog } from './magpie-routing.ts';
import { previewMissionNotification } from './mission-channels.ts';
import { createLocalDeliveryCoordinator } from './local-delivery.ts';
import { ProjectWorkspace } from './project-workspace.ts';
import { createProjectPreviewCoordinator } from './project-agents.ts';
import { checkSmokePrice, DEEPSEEK_PEAK_CNY } from './deepseek-price.ts';
import { projectLiveIsolationGate } from './project-isolation.ts';
import type { WorkerSession } from '@daming/workers';
import type { CodexExecResult } from '@daming/worker-process';
import { CODEX_WEB_SOURCE, CodexWebApproval, CodexApprovalError } from './codex-web-approval.ts';
import { runCodexMagpieTurn } from './codex-magpie.ts';

export interface BoardHostOptions {
  /** Host-only offline test runner. Never accepted from HTTP or environment configuration. */
  readonly codexSubscriptionTest?: { readonly run: (prompt: string, signal: AbortSignal) => Promise<CodexExecResult> };
  readonly dataDir: string;
  readonly port?: number;
  readonly bootstrapToken?: string;
  readonly readOnlyBootstrapToken?: string;
  /** Desktop fixed-user mode: one machine = one auto-authenticated local owner (no login/MFA). */
  readonly singleUser?: boolean;
  readonly webRoot?: string;
  readonly allowedDevOrigins?: readonly string[];
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
  readonly lulu?: LuluStatusProvider;
  readonly luluService?: LuluService;
  readonly deepseekBalance?: DeepSeekBalanceService;
  readonly autoloop?: AutoloopService;
  readonly magpie?: MagpieHost;
  /** Host-only deterministic verification adapter for tests; never accepted from HTTP. */
  /** Offline test adapter; NEVER supplied from HTTP or production configuration. */
  readonly identityBillingReadTest?: OfficialReadTransport;
  /** Test-only offline driver. It is never a paid provider adapter. */
  readonly agentGraphTestDriver?: OfflineAgentDriver;
  /** Synthetic official admin adapter only in isolated HTTP tests. */
  readonly openAiKeyIssuanceTest?: OpenAiAdminTransport;
  /** Host-only synthetic egress, NEVER configurable from browser requests. */
  readonly paidEgressTest?: { readonly transport: PaidModelTransport;
    readonly runner?: TrustedAgentRunner };
  readonly identityProofTest?: {
    readonly verifyVendor: (provider: ProviderKind, secret: string, modelId: string) => Promise<boolean>;
    readonly matchMagpie: (binding: CredentialBinding, provider: ProviderKind, secret: string) => Promise<boolean>;
  };
  readonly confirmMagpieAction?: (request: WindowsApprovalRequest) => Promise<boolean>;
  readonly codexProbe?: CodexProbeService;
  /** Host-side test injection: never accepted from HTTP or sent to the browser. */
  readonly projectPreviewTest?: { readonly sourceRoot: string; readonly mockWorkers: { codex: WorkerSession; dsh: WorkerSession } };
}

export interface BoardHostHandle {
  readonly url: string;
  readonly port: number;
  readonly address: string;
  readonly bootstrapToken: string;
  readonly readOnlyBootstrapToken?: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function magpieError(error: unknown): HttpError {
  const reason = error instanceof Error ? error.message : 'magpie_unavailable';
  if (reason === 'unsupported_magpie_path') return new HttpError(404, reason);
  if (reason === 'invalid_magpie_action_body' || reason === 'magpie_plugin_not_installed') return new HttpError(400, reason);
  if (reason === 'magpie_action_in_progress') return new HttpError(409, reason);
  if (reason === 'magpie_not_ready') return new HttpError(503, reason);
  return new HttpError(502, reason.startsWith('magpie_') ? reason : 'magpie_upstream_failed');
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function defaultWebRoot(): string {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function sendError(res: ServerResponse, status: number, reason: string): void {
  const body: ApiErrorView = { error: reason, reason };
  sendJson(res, status, body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.end(body);
}

function readJsonBody(req: IncomingMessage, maximum = 65536): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function staticPath(webRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) return undefined;
  const target = resolve(webRoot, ...segments);
  if (target !== webRoot && !target.startsWith(webRoot + sep)) return undefined;
  return target;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, webRoot: string): void {
  if (!existsSync(webRoot)) {
    sendHtml(res, 503, '<!doctype html><meta charset="utf-8"><title>Daming</title><p>网页尚未构建，请先运行 pnpm build:web。</p>');
    return;
  }
  const wanted = staticPath(webRoot, pathname);
  if (!wanted) {
    sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>Daming</title><p>Not found.</p>');
    return;
  }
  let file = wanted;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (pathname.includes('.') || pathname.startsWith('/assets/')) {
      sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>Daming</title><p>Not found.</p>');
      return;
    }
    file = join(webRoot, 'index.html');
    if (!existsSync(file)) {
      sendHtml(res, 503, '<!doctype html><meta charset="utf-8"><title>Daming</title><p>网页尚未构建，请先运行 pnpm build:web。</p>');
      return;
    }
  }
  const body = readFileSync(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(body.byteLength));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.endsWith('index.html')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  } else {
    // Local desktop upgrades replace styles.css in place; a stale hour-long cache made the
    // new UI render unstyled until the cache expired. Always revalidate non-hashed assets.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function isWriteMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function requireSameOrigin(req: IncomingMessage, allowedOrigins: ReadonlySet<string>): void {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, 'origin_rejected');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') throw new HttpError(403, 'cross_site_rejected');
}

function requireCsrf(req: IncomingMessage, session: Session): void {
  const token = req.headers['x-daming-csrf'];
  if (typeof token !== 'string' || token !== session.csrfToken) throw new HttpError(403, 'csrf_rejected');
}

/** Read a user-authored spec.md: JSON array if present, otherwise one clause per non-heading line. */
function parseSpecDocument(text: string): SpecClause[] {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, 'project_spec_empty');
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('empty');
      return parsed as SpecClause[];
    } catch { throw new HttpError(400, 'project_spec_invalid_json'); }
  }
  const lines = trimmed.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) throw new HttpError(400, 'project_spec_empty');
  return lines.map((line, index) => ({ id: 'spec-' + (index + 1), text: line }));
}

/** Read plan_baseline.md: JSON array if present, otherwise one step per non-heading line. */
function parsePlanDocument(text: string): PlanStep[] {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, 'project_plan_empty');
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('empty');
      return parsed as PlanStep[];
    } catch { throw new HttpError(400, 'project_plan_invalid_json'); }
  }
  const lines = trimmed.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) throw new HttpError(400, 'project_plan_empty');
  return lines.map((line, index) => ({ stepId: 'step-' + (index + 1), description: line }));
}

function projectIdFromDirectory(directory: unknown): string {
  if (typeof directory === 'string' && directory.trim()) {
    const slug = directory.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (/^[a-z0-9][a-z0-9._-]{2,63}$/.test(slug)) return slug;
  }
  return 'project-' + randomBytes(4).toString('hex');
}

export async function startBoardHost(options: BoardHostOptions): Promise<BoardHostHandle> {
  if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim()) throw new Error('dataDir is required');
  const port = options.port ?? 3210;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const lock = await acquireHostLock(options.dataDir);
  let store: SqliteStore | undefined;
  let operationJournal: MagpieOperationJournal | undefined;
  let pendingStartup: Promise<void> | undefined;
  let ownedMagpie: MagpieHost | undefined;
  let codexWeb: CodexWebApproval | undefined;
  let ownedAutoloop: AutoloopService | undefined;
  let ownedMission: MissionControl | undefined;
  let ownedAgentGraph: AgentOrchestrator | undefined;
  let ownedIdentityRegistry: IdentityRegistry | undefined;
  let tenantBudgetLedger: TenantBudgetLedger | undefined;
  let modelBindingStore: ModelBindingStore | undefined;
  let projectInputStore: ProjectInputStore | undefined;
  let portfolioStore: PortfolioGovernanceStore | undefined;
  let portfolioNotifyStore: PortfolioNotifyStore | undefined;
  let portfolioNotifier: PortfolioNotifier | undefined;
  let portfolioDecisionStore: PortfolioDecisionStore | undefined;
  let platformProviderStore: ProviderStore | undefined;
  let platformAgentStore: AgentProfileStore | undefined;
  let agentRoomStore: AgentRoomStore | undefined;
  let routingGroupStore: RoutingGroupStore | undefined;
  let routingProfileStore: ProfileStore | undefined;
  let gatewayRequestStore: RequestLogStore | undefined;
  let gatewayServeManagerInstance: GatewayServeManager | undefined;
  let notificationHub: NotificationHub | undefined;
  let crewPlanStore: CrewPlanStore | undefined;
  let pipelineRunStore: PipelineRunStore | undefined;
  let maskingStoreInstance: MaskingStore | undefined;
  let activeTimer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  const sockets = new Set<Socket>();
  const liveEvents = new BoardLiveEvents();
  let closed = false;
  try {
    mkdirSync(join(lock.base, 'host'), { recursive: true });
    store = new SqliteStore(join(lock.base, 'host', 'tasks.sqlite'));
    const engine = new Engine(store, store);
    const coordinator = createBoardCoordinator(store, engine);
    const codexExecutable = process.env.DAMING_CODEX_EXE?.trim();
    const codexModel = process.env.DAMING_CODEX_MODEL?.trim();
    const codexOfficial = process.env.DAMING_CODEX_OFFICIAL === '1';
    const codexOptions = { model: codexModel, ignoreUserConfig: codexOfficial };
    const realCoordinator = codexExecutable
      ? createRealCodexCoordinator(store, engine, codexExecutable, join(lock.base, 'codex-real-workspaces'), 'manual', codexOptions.model, codexOptions.ignoreUserConfig)
      : undefined;
    const deepseekBalance = options.deepseekBalance ?? createDeepSeekBalanceService(process.env);
    const dshExecutable = process.env.DAMING_DSH_EXE?.trim();
    const dshEntry = process.env.DAMING_DSH_ENTRY?.trim();
    const dshCoordinator = dshExecutable && dshEntry
      ? createRealDshCoordinator(store, engine, dshExecutable, dshEntry, join(lock.base, 'dsh-real-workspaces'), 'manual', deepseekBalance.configured ? () => deepseekBalance.snapshot() : undefined)
      : undefined;
    const claudeCoordinator = createRealClaudeCoordinator(store, engine, join(lock.base, 'claude-real-workspaces'), 'manual');
    const localWorkspaceRoot = join(lock.base, 'local-deliveries');
    const localCoordinator = createLocalDeliveryCoordinator(store, engine, localWorkspaceRoot);
    let projectWorkspace: ProjectWorkspace | undefined;
    let projectCoordinator: ReturnType<typeof createProjectPreviewCoordinator> | undefined;
    let projectStatusReason = 'not_configured';
    const previewTest = options.projectPreviewTest;
    const projectOptIn = process.env.DAMING_ENABLE_PROJECT_AGENTS === '1';
    if (previewTest) {
      projectWorkspace = new ProjectWorkspace(previewTest.sourceRoot, join(lock.base, 'project-previews'));
      projectCoordinator = createProjectPreviewCoordinator({
        workspace: projectWorkspace, engine, store, mockWorkers: previewTest.mockWorkers
      });
      projectStatusReason = 'offline_test_double';
    } else if (projectOptIn && !projectLiveIsolationGate().ready) {
      // An offline WSL/Bubblewrap proof does NOT isolate the existing Windows CLI processes.
      // Do not create the production coordinator until the real model runner is isolated.
      projectStatusReason = projectLiveIsolationGate().reason;
    } else if (projectOptIn) {
      const sourceRoot = process.env.DAMING_PROJECT_SOURCE_ROOT?.trim();
      if (!sourceRoot || !codexExecutable || !dshExecutable || !dshEntry) {
        projectStatusReason = 'project_cli_or_source_not_configured';
      } else {
        try {
          // An expired price basis must NEVER turn into a real paid DSH call.
          checkSmokePrice();
          if (!deepseekBalance.configured) throw new Error('project_cash_snapshot_unavailable');
          projectWorkspace = new ProjectWorkspace(sourceRoot, join(lock.base, 'project-previews'));
          projectCoordinator = createProjectPreviewCoordinator({
            workspace: projectWorkspace, engine, store,
            codex: { executable: codexExecutable, ...codexOptions },
            dsh: { executable: dshExecutable, entry: dshEntry },
            cashSnapshot: () => deepseekBalance.snapshot()
          });
          projectStatusReason = 'ready_for_explicit_approval';
        } catch {
          projectStatusReason = 'pricing_or_workspace_verification_required';
        }
      }
    }
    const routes = new TaskRouteService(store, coordinator, realCoordinator, dshCoordinator, () => liveEvents.publish('tasks'), localCoordinator, localWorkspaceRoot, projectCoordinator, projectWorkspace, claudeCoordinator);
    const modelBindings = (): ModelBindingStore => (modelBindingStore ??= new ModelBindingStore(join(lock.base, 'host', 'model-bindings')));
    const projectInputs = (): ProjectInputStore => (projectInputStore ??= new ProjectInputStore(join(lock.base, 'host', 'project-inputs')));
    const workbench = (): ProjectWorkbench => new ProjectWorkbench(join(lock.base, 'projects'));
    let gitAccountStore: GitAccountStore | undefined;
    let projectGitInstance: ProjectGit | undefined;
    const gitAccounts = (): GitAccountStore => (gitAccountStore ??= new GitAccountStore(join(lock.base, 'host')));
    const projectGit = (): ProjectGit => (projectGitInstance ??= new ProjectGit(join(lock.base, 'projects'), gitAccounts()));
    const workbenchSeed = (projectId: string): WorkbenchSeed => {
      const frozen = projectInputs().latest(projectId);
      if (!frozen) throw new HttpError(404, 'project_input_missing');
      return {
        title: projectId,
        spec: frozen.spec.map((clause) => ({ id: clause.id, text: clause.text })),
        plan: frozen.planBaseline.map((step) => ({ stepId: step.stepId, description: step.description }))
      };
    };
    const portfolioProfiles = (): PortfolioGovernanceStore => (portfolioStore ??= new PortfolioGovernanceStore(join(lock.base, 'host', 'portfolio-governance')));
    const portfolioDecisions = (): PortfolioDecisionStore => (portfolioDecisionStore ??= new PortfolioDecisionStore(join(lock.base, 'host', 'portfolio-decisions')));
    const portfolioDigestView = (now: number): PortfolioDigestView => {
      const projects = projectInputs().listAll().flatMap((row) => {
        const frozen = projectInputs().latest(row.projectId);
        if (!frozen) return [];
        return [projectInputToPortfolioView({ projectId: row.projectId, frozen, progress: projectInputs().getProgress(row.projectId), now })];
      });
      const profiles: Record<string, AutonomyProfileView> = {};
      for (const project of projects) profiles[project.projectId] = portfolioProfiles().getProfile(project.projectId);
      const dayKey = new Date(now).toISOString().slice(0, 10);
      return buildPortfolioDigest({ projects, profiles, now, interruptUsed: portfolioProfiles().interruptsFor(dayKey),
        suppressed: new Set(portfolioDecisions().resolvedItemIds()) });
    };
    const portfolioNotify = (): PortfolioNotifier => (portfolioNotifier ??= new PortfolioNotifier(
      portfolioNotifyStore ??= new PortfolioNotifyStore(join(lock.base, 'host', 'portfolio-notify')),
      (event, text) => notifications().notify(event, text)
    ));
    const platformProviders = (): ProviderStore => (platformProviderStore ??= new ProviderStore(join(lock.base, 'host', 'platform')));
    const platformAgents = (): AgentProfileStore => (platformAgentStore ??= new AgentProfileStore(join(lock.base, 'host', 'platform')));
    const routingGroups = (): RoutingGroupStore => (routingGroupStore ??= new RoutingGroupStore(join(lock.base, 'host', 'platform')));
    const routingProfiles = (): ProfileStore => (routingProfileStore ??= new ProfileStore(join(lock.base, 'host', 'platform')));
    const gatewayRequests = (): RequestLogStore => (gatewayRequestStore ??= new RequestLogStore(join(lock.base, 'host', 'gateway')));
    const gatewayServeManager = (): GatewayServeManager => (gatewayServeManagerInstance ??= new GatewayServeManager({
      scriptPath: process.env.DAMING_GATEWAY_SERVE_SCRIPT?.trim()
        || (existsSync(join(dirname(process.argv[1] ?? ''), 'gateway-serve.mjs'))
          ? join(dirname(process.argv[1] ?? ''), 'gateway-serve.mjs')
          : join(process.cwd(), 'scripts', 'daming-gateway-serve.mjs')),
      providersFile: platformProviders().file,
      port: Number(process.env.DAMING_GATEWAY_PORT ?? 3460)
    }));
    const ingestGatewayUsage = async (): Promise<void> => {
      const status = gatewayServeManagerInstance?.status();
      if (!status || status.state !== 'running') return;
      try {
        const response = await fetch('http://127.0.0.1:' + status.port + '/api/usage/recent');
        if (!response.ok) return;
        const data = await response.json() as { recent?: { at: string; endpoint: string; model: string; provider: string; input: number; output: number; cached: number; taskId?: string; agentId?: string }[] };
        let appended = 0;
        for (const row of data.recent ?? []) {
          const requestId = [row.at, row.provider, row.model, row.input, row.output, row.taskId ?? ''].join('|');
          if (gatewayRequests().get(requestId)) continue;
          gatewayRequests().append({
            requestId, at: row.at, agent: row.agentId ?? 'gateway', providerId: row.provider, modelId: row.provider + '/' + row.model,
            status: 'ok', latencyMs: 0, inputTokens: row.input, outputTokens: row.output,
            ...(row.input > 0 ? { cacheHitPercent: Math.round((row.cached / row.input) * 1000) / 10 } : {}), maskedCount: 0,
            // Attribution comes from the gateway record; never inferred from the model name.
            ...(row.taskId ? { taskId: row.taskId } : {})
          });
          appended++;
        }
        // Only after the rows are durably appended does the observability page get a hint.
        if (appended > 0) liveEvents.publish('gateway', 'usage');
      } catch { /* best effort */ }
    };
    const platformAvailableModels = (): AvailableModelView[] => platformProviders().list().flatMap((provider) =>
      provider.models.map((model) => ({
        modelId: provider.id + '/' + model, providerId: provider.id,
        sourceKind: 'official_api' as const, billing: 'cash' as const, quota: {}, dispatchable: true
      })));
    const mergePlatformModels = (view: AvailableModelsView): AvailableModelsView => {
      const seen = new Set(view.models.map((model) => model.modelId));
      const extra = platformAvailableModels().filter((model) => !seen.has(model.modelId));
      return { ...view, models: [...view.models, ...extra].sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)) };
    };
    // 执行链真实模式运行时：执行 / 评审 / 协作群讨论都走自托管 gateway 的真实模型；未就绪则 fail-closed。
    const pipelineRealRuntime = (goal: string): RealPipelineRuntime => {
      const status = gatewayServeManager().status();
      if (!status || status.state !== 'running' || typeof status.port !== 'number') {
        throw new HttpError(409, 'pipeline_real_gateway_not_running');
      }
      const modelId = process.env.DAMING_PIPELINE_MODEL?.trim() || platformAvailableModels()[0]?.modelId;
      if (!modelId) throw new HttpError(409, 'pipeline_real_model_not_configured');
      const providerId = modelId.includes('/') ? modelId.split('/')[0] : '';
      const port = gatewayTextPort({
        baseUrl: 'http://127.0.0.1:' + status.port, model: modelId,
        // 统一出口脱敏：Daming 自己转发给 Agent/LLM 的提示词先脱敏再上传（豁免供应商除外）。
        mask: (text: string) => {
          const settings = maskingStore().get();
          if (providerId && settings.exemptProviders.includes(providerId)) return text;
          return maskOutboundText(text, settings).masked;
        }
      });
      return createRealPipelineRuntime(port, goal);
    };
    const availableCatalog = async (tenantId: string): Promise<AvailableModelsView> => {
      try {
        if (!magpie.unifiedTargets) throw new Error('not_supported');
        const catalog = await magpie.unifiedTargets();
        return mergePlatformModels(listAvailableModels({ tenantId, source: { catalog: catalog as never } }));
      } catch {
        return mergePlatformModels({ tenantId, models: [], checkedAt: new Date().toISOString(), dispatchEnabled: false });
      }
    };
    const portfolioPushEnabled = (): boolean => notifications().list().channels.some((channel) => channel.enabled && channel.configured);
    const notifications = (): NotificationHub => (notificationHub ??= new NotificationHub(join(lock.base, 'host')));
    const crewPlans = (): CrewPlanStore => (crewPlanStore ??= new CrewPlanStore(join(lock.base, 'host')));
    const pipelineRuns = (): PipelineRunStore => (pipelineRunStore ??= new PipelineRunStore(join(lock.base, 'host')));
  const maskingStore = (): MaskingStore => (maskingStoreInstance ??= new MaskingStore(join(lock.base, 'host', 'masking')));
    const agentRooms = (): AgentRoomStore => (agentRoomStore ??= new AgentRoomStore(join(lock.base, 'host')));
    const luluService = options.luluService ?? (options.lulu ? undefined : createLuluService(process.env, { runStorePath: join(lock.base, 'lulu-runs.json') }));
    const lulu = options.lulu ?? luluService!;
    const autoloopDsh = dshExecutable && dshEntry
      ? createRealDshCoordinator(store, engine, dshExecutable, dshEntry, join(lock.base, 'dsh-real-workspaces'), 'auto', deepseekBalance.configured ? () => deepseekBalance.snapshot() : undefined)
      : undefined;
    const autoloopCodex = codexExecutable
      ? createRealCodexCoordinator(store, engine, codexExecutable, join(lock.base, 'codex-real-workspaces'), 'auto', codexOptions.model, codexOptions.ignoreUserConfig)
      : undefined;
    const missionControl = new MissionControl(join(lock.base, 'command-room'), () => liveEvents.publish('missions'));
    ownedMission = missionControl;
    const agentGraph = new AgentOrchestrator(join(lock.base, 'command-room'), {
      onChanged: () => liveEvents.publish('missions'),
      ...(options.agentGraphTestDriver ? { driver: options.agentGraphTestDriver } : {})
    });
    ownedAgentGraph = agentGraph;
    const autoloopRunJob = createAutoloopJobRunner({
      ...(autoloopDsh ? { runDsh: (job) => runCoordinatorTask(autoloopDsh, job, createRealDshPlan) } : {}),
      ...(autoloopCodex ? { runCodex: (job) => runCoordinatorTask(autoloopCodex, job, createRealCodexPlan) } : {})
    });
    const autoloopHealth: AutoloopAgentHealthView[] = [
      {
        id: 'echo', status: 'available', reason: '进程内演示 Agent'
      },
      {
        id: 'dsh',
        status: autoloopDsh && process.env.DEEPSEEK_API_KEY?.trim() ? 'available' : 'unavailable',
        reason: autoloopDsh && process.env.DEEPSEEK_API_KEY?.trim() ? 'DSH headless + DeepSeek API key 已配置' : '缺少 DSH 路径/入口或 DeepSeek API key'
      },
      {
        id: 'codex',
        status: autoloopCodex ? 'available' : 'unavailable',
        reason: autoloopCodex ? (codexOfficial ? 'Codex 官方路由（--ignore-user-config + CODEX_HOME 登录态）' : 'Codex CLI 已配置；本机模型路由由 CODEX_HOME/config.toml 决定') : '缺少 DAMING_CODEX_EXE'
      }
    ];
    const autoloop = options.autoloop ?? createAutoloopService({ dataDir: lock.base,
      runJob: (job) => job.agent.use === 'mission' ? missionControl.autoloopJob(job) : autoloopRunJob(job),
      agentHealth: autoloopHealth });
    ownedAutoloop = autoloop;
    const autoloopTimer = setInterval(() => { void autoloop.tick(); }, 30000);
    activeTimer = autoloopTimer;
    autoloopTimer.unref();
    // Notification watcher: pushes task/autoloop changes to Feishu/WeCom/WeChat/QQ/webhook.
    const taskSeen = new Map<string, string>();
    let taskWatchReady = false;
    let lastAutoloopCards = autoloop.state().totals.cards;
    const statusEvent: Partial<Record<string, NotificationEvent>> = {
      awaiting_approval: 'task.approval', reviewing: 'task.review', blocked: 'task.blocked',
      completed: 'task.completed', failed: 'task.failed'
    };
    const notificationTimer = setInterval(() => {
      void (async () => {
        try {
          const current = routes.list();
          if (!taskWatchReady) {
            for (const task of current) taskSeen.set(task.taskId, task.status);
            taskWatchReady = true;
            return;
          }
          for (const task of current) {
            const before = taskSeen.get(task.taskId);
            if (before === undefined) {
              taskSeen.set(task.taskId, task.status);
              await notifications().notify('task.created', '新任务：' + task.title);
            } else if (before !== task.status) {
              taskSeen.set(task.taskId, task.status);
              const event = statusEvent[task.status];
              if (event) await notifications().notify(event, task.title + ' → ' + task.status);
            }
          }
          const cards = autoloop.state().totals.cards;
          if (cards > lastAutoloopCards) {
            await notifications().notify('autoloop.card', 'Autoloop 有 ' + (cards - lastAutoloopCards) + ' 张新的待拍板卡');
          }
          lastAutoloopCards = cards;
        } catch { /* notification failures never affect task execution */ }
      })();
    }, 15000);
    notificationTimer.unref();
    // Portfolio watcher: pushes new lifeline items in real time + a once-a-day digest
    // to the channels configured on the 通知 page. De-duplicated; skipped if no channel enabled.
    const portfolioTimer = setInterval(() => {
      void (async () => {
        try { if (portfolioPushEnabled()) await portfolioNotify().run(portfolioDigestView(Date.now())); }
        catch { /* portfolio push failures never affect task execution */ }
      })();
    }, 60000);
    portfolioTimer.unref();
    const gatewayUsageTimer = setInterval(() => { void ingestGatewayUsage(); }, 10000);
    gatewayUsageTimer.unref();
    // Attach by explicit localhost gateway key when the user wants to retain
    // the existing Magpie desktop's Agent subscriptions and routing groups.
    // Never import its account store, replace its binary or alter its rules.
    const existingGatewayPort = process.env.DAMING_MAGPIE_EXISTING_GATEWAY_PORT?.trim();
    const attachedMagpie = options.magpie || !existingGatewayPort ? undefined :
      createAttachedMagpieHost({ port: Number(existingGatewayPort),
        key: process.env.DAMING_MAGPIE_EXISTING_GATEWAY_KEY ?? '' });
    const profile = options.magpie || attachedMagpie ? undefined : chooseMagpieProfile(lock.base, process.env);
    const magpie = options.magpie ?? attachedMagpie ?? createMagpieHost({
      dataDir: profile!.dataDir, profile: profile!.profile, port: Number(process.env.DAMING_MAGPIE_PORT ?? 3457)
    });
    ownedMagpie = magpie;
    const buildCrewCatalog = async (tenantId: string): Promise<AvailableModelsView> => {
      let catalog: unknown;
      try {
        if (!magpie.unifiedTargets) throw new Error('not_supported');
        catalog = await magpie.unifiedTargets();
      } catch {
        return { tenantId, models: [], checkedAt: new Date().toISOString(), dispatchEnabled: false } as AvailableModelsView;
      }
      let quotas: { providerId: string; remainingPercent?: number; resetsAt?: string }[] = [];
      try {
        const read = await magpie.read('quotas') as unknown as { items?: readonly { id?: string; remainingPercent?: number; resetsAt?: string }[] };
        if (read && Array.isArray(read.items)) {
          quotas = read.items.filter((item) => typeof item.id === 'string').map((item) => ({
            providerId: item.id as string,
            ...(typeof item.remainingPercent === 'number' ? { remainingPercent: item.remainingPercent } : {}),
            ...(typeof item.resetsAt === 'string' ? { resetsAt: item.resetsAt } : {})
          }));
        }
      } catch { quotas = []; }
      return listAvailableModels({ tenantId, source: { catalog: catalog as never, ...(quotas.length ? { quotas } : {}) } });
    };
    const desktopCodexRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const subscriptionExecutable = codexExecutable || (existsSync(desktopCodexRoot)
      ? readdirSync(desktopCodexRoot).sort().reverse().map(dir => join(desktopCodexRoot, dir, 'codex.exe')).find(existsSync)
      : undefined);
    codexWeb = new CodexWebApproval(store, engine, {
      onChanged: () => liveEvents.publish('codex'),
      binding: async () => {
        if (!options.codexSubscriptionTest && (!subscriptionExecutable || !magpie.withPinnedModel)) {
          throw new CodexApprovalError(503, 'runtime_unavailable');
        }
        if (!await magpie.scopeCapability?.() || !magpie.codexSubscriptionBinding) {
          throw new CodexApprovalError(503, 'scope_unavailable');
        }
        try { return await magpie.codexSubscriptionBinding('gpt-6.1-sol'); }
        catch { throw new CodexApprovalError(503, 'subscription_unavailable'); }
      },
      run: async (binding, prompt, signal) => {
        if (options.codexSubscriptionTest) return options.codexSubscriptionTest.run(prompt, signal);
        const workRoot = join(lock.base, 'codex-web-workspaces');
        mkdirSync(workRoot, { recursive: true });
        const workspace = mkdtempSync(join(workRoot, 'run-'));
        try { return await runCodexMagpieTurn(magpie, binding, {
          executable: subscriptionExecutable!, cwd: workspace, prompt, signal, timeoutMs: 45000
        }); } finally {
          // mkdtemp's resolved child is the only deletion target; never use a browser-supplied path.
          if (resolve(workspace).startsWith(resolve(workRoot) + sep)) {
            try { rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
            catch { /* leave this isolated directory for manual cleanup */ }
          }
        }
      }
    });
    const magpieStartup = magpie.ensure().catch(() => undefined);
    pendingStartup = magpieStartup.then(() => undefined);
    operationJournal = new MagpieOperationJournal(lock.base);
    const operations = operationJournal;
    const nativeApproval = options.confirmMagpieAction ?? requestWindowsNativeApproval;
    const consentInFlight = new Set<string>();
    const scopeConsentInFlight = new Set<string>();
    const credentialProofInFlight = new Set<string>();
    const isolatedProbeInFlight = new Set<string>();
    const dockerAgentProbeInFlight = new Set<string>();
    const livePaidEgressInFlight = new Set<string>();
    // Process-local evidence deliberately expires; a restart never inherits
    // sandbox trust merely because an old probe once succeeded.
    const dockerAgentProbeAt = new Map<string, number>();
    const openAiKeyIssueInFlight = new Set<string>();
    const billingObservationInFlight = new Set<string>();
    const officialIssuedKeyCostInFlight = new Set<string>();
    const officialSpendLimitInFlight = new Set<string>();
    const codexProbe = options.codexProbe ?? createCodexProbe(join(lock.base, 'codex-probes'));
    const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString('base64url');
    const tokens: BootstrapToken[] = [{ value: bootstrapToken, role: 'readwrite' }];
    if (options.readOnlyBootstrapToken) tokens.push({ value: options.readOnlyBootstrapToken, role: 'readonly' });
    const sessions = new SessionManager({ tokens, now: options.now, ttlMs: options.sessionTtlMs });
    const singleUser = options.singleUser === true || process.env.DAMING_SINGLE_USER === '1';
    // Lazy initialization keeps the legacy offline test Host unchanged until
    // a real owner opts into persistent identity. Once initialized, bootstrap
    // sessions can no longer bypass the authenticated tenant boundary.
    const identityDir = join(lock.base, 'identity');
    const identityDbPath = join(identityDir, 'identities.db');
    const identityRequiredMarker = join(lock.base, 'identity-required.flag');
    if (!singleUser && existsSync(identityRequiredMarker) && !existsSync(identityDbPath)) {
      throw new Error('Persistent identity database missing; refusing unsafe legacy bootstrap fallback');
    }
    let identityRegistry: IdentityRegistry | undefined;
    const identityStore = (): IdentityRegistry => {
      if (!identityRegistry) {
        if (!existsSync(identityDir)) {
          mkdirSync(identityDir, { recursive: true, mode: 0o700 });
          secureNewWindowsDirectory(identityDir);
        }
        identityRegistry = new IdentityRegistry(identityDir);
        ownedIdentityRegistry = identityRegistry;
      }
      return identityRegistry;
    };
    const budgetLedger = (): TenantBudgetLedger => {
      if (!tenantBudgetLedger) {
        identityStore(); // creates the private, ACL-protected identity directory
        tenantBudgetLedger = new TenantBudgetLedger(identityDir);
      }
      return tenantBudgetLedger;
    };
    let paidBroker: TrustedPaidEgress | undefined;
    const paidEgress = (): TrustedPaidEgress => {
      if (!paidBroker) paidBroker = new TrustedPaidEgress(
        identityStore(), budgetLedger(),
        !!options.paidEgressTest || process.env.DAMING_ENABLE_PAID_EGRESS === '1',
        options.paidEgressTest?.transport,
        options.paidEgressTest?.runner
      );
      return paidBroker;
    };
    const existingIdentity = (): IdentityRegistry | undefined =>
      identityRegistry ?? (existsSync(identityDbPath) ? identityStore() : undefined);
    // Desktop fixed-user mode: provision exactly one local owner that is bound to this machine,
    // so the board opens already signed in and never shows an administrator/login screen.
    if (singleUser) {
      await identityStore().ensureLocalOwner();
    }
    const identityInitialized = (): boolean => existingIdentity()?.initialized() ?? false;
    // A previously migrated Host must NEVER accept an empty/recreated DB
    // as an invitation to create a second root administrator.
    if (!singleUser && existsSync(identityRequiredMarker) && !identityInitialized()) {
      throw new Error('Persistent root identity missing; refusing legacy bootstrap fallback');
    }
    // Import old tasks exactly once; no unowned legacy task is auto-adopted later.
    if (identityInitialized()) {
      identityStore().migrateLegacyTasks(routes.list().map(task => task.taskId));
      identityStore().migrateLegacyMissions(missionControl.list().map(m => m.missionId));
    }
    const getRequestSession = (cookie: string | undefined): Session | undefined => {
      const registry = existingIdentity();
      if (registry?.initialized()) return registry.getSession(cookie);
      return sessions.get(cookie);
    };
    const webRoot = resolve(options.webRoot ?? defaultWebRoot());
    const allowedOrigins = new Set<string>();
    let expectedOrigin = '';
    let allowedHosts = new Set<string>();

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        const host = req.headers.host;
        if (!host || !allowedHosts.has(host) || req.headers['x-forwarded-host'] !== undefined) throw new HttpError(403, 'host_rejected');
        const url = new URL(req.url ?? '/', expectedOrigin || 'http://127.0.0.1');
        const session = getRequestSession(req.headers.cookie);
        const principal = session?.identity;
        const registry = existingIdentity();
        const initialized = registry?.initialized() ?? false;
        const identityPath = url.pathname.startsWith('/api/identity/');
        const readInput = async (maximum = 8192): Promise<Record<string, unknown>> => {
          const body = await readJsonBody(req, maximum);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'identity_input_invalid');
          return body as Record<string, unknown>;
        };
        const allowOnly = (body: Record<string, unknown>, fields: readonly string[]) => {
          if (Object.keys(body).some(key => !fields.includes(key))) throw new HttpError(400, 'identity_unknown_field');
        };
        const issueIdentityCookie = (cookie: string, current: Session): void => {
          res.setHeader('Set-Cookie', sessionCookie('daming_identity', cookie,
            Math.max(1, Math.floor((current.expiresAt - Date.now()) / 1000))));
          sendJson(res, 200, {
            role: current.role, expiresAt: new Date(current.expiresAt).toISOString(),
            csrfToken: current.csrfToken, identity: current.identity,
            ...(current.identity ? { mfaEnabled: identityStore().hasMfa(current.identity) } : {})
          });
        };

        if (url.pathname === '/api/identity/status' && req.method === 'GET') {
          sendJson(res, 200, { initialized, singleUser });
          return;
        }
        if (url.pathname === '/api/identity/setup' && req.method === 'POST') {
          if (singleUser) throw new HttpError(409, 'single_user_mode');
          if (initialized) throw new HttpError(409, 'identity_already_initialized');
          const legacySession = sessions.get(req.headers.cookie);
          if (!legacySession || legacySession.role !== 'readwrite') throw new HttpError(403, 'bootstrap_owner_required');
          requireSameOrigin(req, allowedOrigins);
          requireCsrf(req, legacySession);
          const body = await readInput();
          allowOnly(body, ['username', 'password', 'tenantName']);
          // Write the fail-closed migration sentinel BEFORE creating the
          // first privileged user; a crash cannot fall back to bootstrap.
          if (!existsSync(identityRequiredMarker)) {
            writeFileSync(identityRequiredMarker, 'persistent-identity-required\n', { flag: 'wx', mode: 0o600 });
          }
          const opened = await identityStore().setup({
            username: body.username, password: body.password, tenantName: body.tenantName
          });
          identityStore().migrateLegacyTasks(routes.list().map(task => task.taskId));
          identityStore().migrateLegacyMissions(missionControl.list().map(m => m.missionId));
          issueIdentityCookie(opened.cookie, opened.session);
          return;
        }
        if ((url.pathname === '/api/identity/login' || url.pathname === '/api/identity/enroll') &&
            req.method === 'POST') {
          if (singleUser) throw new HttpError(409, 'single_user_mode');
          if (!initialized) throw new HttpError(409, 'identity_not_initialized');
          requireSameOrigin(req, allowedOrigins);
          const body = await readInput();
          const opened = url.pathname === '/api/identity/login'
            ? (allowOnly(body, ['username','password','mfaCode']),
              await identityStore().login({ username: body.username, password: body.password,
                ...(body.mfaCode === undefined ? {} : { mfaCode: body.mfaCode }) }))
            : (allowOnly(body, ['username','password','invitationCode']),
              await identityStore().enroll({
                username: body.username, password: body.password, invitationCode: body.invitationCode
              }));
          issueIdentityCookie(opened.cookie, opened.session);
          return;
        }

        if (url.pathname === '/healthz' && req.method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url.pathname === '/api/remote/login' && req.method === 'GET') {
          if (!singleUser) throw new HttpError(400, 'remote_login_single_user_only');
          if (!notifications().verifyRemoteToken(url.searchParams.get('token') ?? '')) {
            throw new HttpError(401, 'remote_token_invalid');
          }
          const opened = identityStore().openLocalOwnerSession();
          res.setHeader('Set-Cookie', sessionCookie('daming_identity', opened.cookie,
            Math.max(1, Math.floor((opened.session.expiresAt - Date.now()) / 1000))));
            res.statusCode = 302;
            const remotePage = url.searchParams.get('page');
            res.setHeader('Location', '/' + (remotePage && /^[a-z-]+$/.test(remotePage) ? '#' + remotePage : ''));
            res.end();
            return;
        }
        if (url.pathname === '/' && req.method === 'GET' && url.searchParams.has('token')) {
          const suppliedToken = url.searchParams.get('token') ?? '';
          if (singleUser) {
            // The per-launch token is only handed to the Electron shell; exchanging it here
            // opens the fixed local owner's session with no password or MFA prompt.
            if (!sessions.open(suppliedToken)) throw new HttpError(401, 'invalid_bootstrap_token');
            const opened = identityStore().openLocalOwnerSession();
            res.setHeader('Set-Cookie', sessionCookie('daming_identity', opened.cookie,
              Math.max(1, Math.floor((opened.session.expiresAt - Date.now()) / 1000))));
            res.statusCode = 302;
            res.setHeader('Location', '/' + (() => { const page = url.searchParams.get('page'); return page && /^[a-z-]+$/.test(page) ? '#' + page : ''; })());
            res.end();
            return;
          }
          if (initialized) throw new HttpError(410, 'bootstrap_login_disabled');
          const opened = sessions.open(suppliedToken);
          if (!opened) throw new HttpError(401, 'invalid_bootstrap_token');
          res.setHeader('Set-Cookie', sessionCookie('daming_session', opened.id, Math.floor((options.sessionTtlMs ?? 12 * 60 * 60 * 1000) / 1000)));
          res.statusCode = 302;
          res.setHeader('Location', '/');
          res.end();
          return;
        }

        if (url.pathname === '/' || !url.pathname.startsWith('/api/')) {
          if (!session && !initialized) {
            sendHtml(res, 401, '<!doctype html><meta charset="utf-8"><title>Daming</title><p>未认证。请使用 pnpm start:web 打印的带 token 链接打开任务板。</p>');
            return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
          serveStatic(req, res, url.pathname, webRoot);
          return;
        }

        if (!session) throw new HttpError(401, 'authentication_required');
        if (initialized && !principal) throw new HttpError(401, 'persistent_identity_required');
        // Before MFA enrollment even GET access to legacy Host-global status,
        // routing inventory, execution history or task data is denied. This
        // prevents a stolen first-factor cookie from reading shared state.
        if (initialized && principal && !identityStore().hasMfa(principal) &&
            !identityPath && url.pathname !== '/api/session') {
          throw new HttpError(403, 'mfa_enrollment_required');
        }

        if (isWriteMethod(req.method)) {
          requireSameOrigin(req, allowedOrigins);
          requireCsrf(req, session);
          const mfaEnrollment = url.pathname === '/api/identity/mfa/begin' ||
            url.pathname === '/api/identity/mfa/confirm';
          if (session.role !== 'readwrite' && !mfaEnrollment) throw new HttpError(403, 'read_only_session');
          // A pre-MFA session is restricted to enrollment and logout, even for
          // the legacy global administrator; no side-effectful routing bypass.
          if (initialized && principal && !mfaEnrollment && url.pathname !== '/api/identity/logout' &&
              !identityStore().hasMfa(principal)) throw new HttpError(403, 'mfa_enrollment_required');
        }

        if (url.pathname === '/api/session' && req.method === 'GET') {
          const body: SessionView = {
            csrfToken: session.csrfToken, role: session.role,
            expiresAt: new Date(session.expiresAt).toISOString(),
            localMode: singleUser,
            ...(principal ? { identity: principal, mfaEnabled: identityStore().hasMfa(principal) } : {})
          };
          sendJson(res, 200, body);
          return;
        }
        if (identityPath) {
          if (!principal || !initialized) throw new HttpError(401, 'persistent_identity_required');
          if (url.pathname === '/api/identity/openai/issuances' && req.method === 'GET') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            sendJson(res, 200, { issuances: identityStore().listOpenAiKeyIssuances(principal) });
            return;
          }
          if (url.pathname === '/api/identity/openai/issue-service-key' &&
              req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            const input = await readInput();
            allowOnly(input, ['requestId', 'projectId', 'serviceAccountId',
              'modelId', 'adminKey', 'confirmation']);
            if (input.confirmation !== 'CREATE_1_HOUR_OPENAI_SERVICE_KEY' ||
                typeof input.requestId !== 'string' || typeof input.projectId !== 'string' ||
                typeof input.serviceAccountId !== 'string' || typeof input.modelId !== 'string' ||
                typeof input.adminKey !== 'string' || input.adminKey.length < 12 ||
                input.adminKey.length > 4096 || /[\r\n\0]/.test(input.adminKey)) {
              throw new HttpError(400, 'openai_admin_explicit_confirmation_required');
            }
            if (openAiKeyIssueInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'openai_key_issuance_in_progress');
            }
            openAiKeyIssueInFlight.add(principal.tenantId);
            let journaled = false;
            try {
              identityStore().beginOpenAiKeyIssuance(principal, {
                requestId: input.requestId, projectId: input.projectId,
                serviceAccountId: input.serviceAccountId, modelId: input.modelId
              });
              journaled = true;
              const issued = await issueOpenAiProjectServiceKey({
                requestId: input.requestId, projectId: input.projectId,
                serviceAccountId: input.serviceAccountId, adminKey: input.adminKey
              }, options.openAiKeyIssuanceTest);
              const active = getRequestSession(req.headers.cookie)?.identity;
              if (!active || active.userId !== principal.userId ||
                  active.tenantId !== principal.tenantId ||
                  active.memberRole !== 'owner' || !identityStore().hasMfa(active)) {
                throw new HttpError(403, 'openai_issuance_identity_changed_during_call');
              }
              const saved = identityStore().completeOpenAiKeyIssuance(
                active, input.requestId, issued);
              sendJson(res, 201, saved);
            } catch (error) {
              if (journaled) {
                try { identityStore().markOpenAiKeyIssuanceUncertain(principal, input.requestId); }
                catch { /* startup marks any unfinished record uncertain */ }
              }
              if (error instanceof IdentityError) throw new HttpError(error.status, error.message);
              if (error instanceof OpenAiKeyIssuanceError) {
                throw new HttpError(error.status, error.message);
              }
              throw new HttpError(503, 'openai_issuance_effect_unknown_manual_reconciliation_required');
            } finally {
              openAiKeyIssueInFlight.delete(principal.tenantId);
            }
            return;
          }
          if (url.pathname === '/api/identity/budget' && req.method === 'GET') {
            sendJson(res, 200, {
              policies: budgetLedger().policies(principal),
              holds: budgetLedger().listHolds(principal),
              paidDispatchPermitted: false,
              note: 'preview_only_no_upstream_spend'
            });
            return;
          }
          if (url.pathname === '/api/identity/budget/policy' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['currency', 'perRequestMinor', 'perUtcDayMinor']);
            try {
              sendJson(res, 200, budgetLedger().configure(principal, {
                currency: body.currency as 'USD' | 'CNY',
                perRequestMinor: body.perRequestMinor as number,
                perUtcDayMinor: body.perUtcDayMinor as number
              }));
            } catch (error) {
              if (error instanceof TenantBudgetError) throw new HttpError(error.status, error.message);
              throw error;
            }
            return;
          }
          if (url.pathname === '/api/identity/budget/preview' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['currency', 'requestId', 'requestedMinor']);
            try {
              sendJson(res, 201, budgetLedger().previewHold(principal, {
                currency: body.currency as 'USD' | 'CNY',
                requestId: body.requestId as string,
                requestedMinor: body.requestedMinor as number
              }));
            } catch (error) {
              if (error instanceof TenantBudgetError) throw new HttpError(error.status, error.message);
              throw error;
            }
            return;
          }
          const budgetCancel =
            /^\/api\/identity\/budget\/holds\/([a-f0-9-]{36})$/.exec(url.pathname);
          if (budgetCancel && req.method === 'DELETE') {
            try {
              sendJson(res, 200, budgetLedger().cancelPreview(principal, budgetCancel[1]));
            } catch (error) {
              if (error instanceof TenantBudgetError) throw new HttpError(error.status, error.message);
              throw error;
            }
            return;
          }
          const budgetUncertain =
            /^\/api\/identity\/budget\/holds\/([a-f0-9-]{36})\/uncertain$/.exec(url.pathname);
          if (budgetUncertain && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, []);
            try {
              sendJson(res, 200, budgetLedger().markUncertain(principal, budgetUncertain[1]));
            } catch (error) {
              if (error instanceof TenantBudgetError) throw new HttpError(error.status, error.message);
              throw error;
            }
            return;
          }
          if (url.pathname === '/api/identity/sandbox/inspect' && req.method === 'POST') {
            if (principal.memberRole === 'viewer') throw new HttpError(403, 'sandbox_operator_required');
            const body = await readInput();
            allowOnly(body, ['text']);
            if (typeof body.text !== 'string' || body.text.length > 2048 ||
                Buffer.byteLength(body.text, 'utf8') > 8192) {
              throw new HttpError(400, 'sandbox_input_invalid');
            }
            if (isolatedProbeInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'tenant_sandbox_already_running');
            }
            isolatedProbeInFlight.add(principal.tenantId);
            try {
              const isolated = await runIsolatedTenantInspect(body.text);
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId ||
                  current.tenantId !== principal.tenantId ||
                  current.memberRole === 'viewer' || !identityStore().hasMfa(current)) {
                throw new HttpError(403, 'sandbox_tenant_changed_during_execution');
              }
              sendJson(res, 200, {
                ...isolated, billingCurrency: null, chargedMinor: 0,
                magpieRunning: false, paidDispatchPermitted: false
              });
            } catch (error) {
              if (error instanceof TenantSandboxError) {
                throw new HttpError(error.reason.endsWith('invalid') ? 400 : 503, error.reason);
              }
              throw error;
            } finally { isolatedProbeInFlight.delete(principal.tenantId); }
            return;
          }
          if (url.pathname === '/api/identity/agent-runtime/probe' && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'agent_runtime_owner_required');
            const body = await readInput();
            allowOnly(body, ['text']);
            if (typeof body.text !== 'string' || body.text.length > 2048 ||
                Buffer.byteLength(body.text, 'utf8') > 8192) {
              throw new HttpError(400, 'docker_agent_input_invalid');
            }
            // One small resource-limited Docker check per Host at a time.
            if (dockerAgentProbeInFlight.size !== 0) throw new HttpError(409, 'docker_agent_probe_in_progress');
            dockerAgentProbeInFlight.add(principal.tenantId);
            try {
              const proof = await probeTenantDockerAgent(body.text);
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId ||
                  current.tenantId !== principal.tenantId ||
                  current.memberRole !== 'owner' || !identityStore().hasMfa(current)) {
                throw new HttpError(403, 'docker_agent_tenant_changed_during_execution');
              }
              dockerAgentProbeAt.set(current.tenantId, Date.now());
              sendJson(res, 200, { ...proof, chargedMinor: 0,
                vendorAccountUsed: false, magpieRunning: false });
            } catch (error) {
              if (error instanceof TenantDockerSandboxError)
                throw new HttpError(error.reason.endsWith('invalid') ? 400 : 503, error.reason);
              throw error;
            } finally { dockerAgentProbeInFlight.delete(principal.tenantId); }
            return;
          }
          if (url.pathname.startsWith('/api/identity/paid-egress/') &&
              !identityStore().hasMfa(principal)) {
            throw new HttpError(403, 'paid_egress_mfa_required');
          }
          if (url.pathname === '/api/identity/paid-egress/attempts' && req.method === 'GET') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            sendJson(res, 200, {
              attempts: paidEgress().list(principal),
              manualOneShotEnabled: paidEgress().availableForManualOneShot,
              automaticAgentDispatchEnabled: false,
              vendorHardCapGuaranteed: false, invoiceReconciliationVerified: false
            });
            return;
          }
          if (url.pathname === '/api/identity/paid-egress/prepare' && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            const body = await readInput();
            allowOnly(body, ['requestId','credentialId','currency','reservedMinor',
              'prompt','maxOutputTokens','safeMemoryTools','confirmation']);
            if (body.confirmation !== 'PREPARE_ONE_PAID_AGENT_ATTEMPT') {
              throw new HttpError(400, 'paid_egress_prepare_confirmation_required');
            }
            try {
              const attempt = paidEgress().prepare(principal, body as PaidAgentInput);
              sendJson(res, 201, { attempt, vendorHardCapGuaranteed: false,
                invoiceReconciliationVerified: false, preparedOnly: true });
            } catch (error) {
              if (error instanceof TenantBudgetError || error instanceof TrustedEgressError) {
                throw new HttpError(error.status, error.message);
              }
              throw error;
            }
            return;
          }
          if (url.pathname === '/api/identity/paid-egress/execute' && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            const body = await readInput();
            allowOnly(body, ['requestId','credentialId','currency','reservedMinor',
              'prompt','maxOutputTokens','safeMemoryTools','confirmation']);
            if (body.confirmation !== 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP') {
              throw new HttpError(400, 'paid_egress_send_confirmation_required');
            }
            if (!options.paidEgressTest) {
              const at = dockerAgentProbeAt.get(principal.tenantId);
              if (at === undefined || Date.now() < at || Date.now() - at > 5 * 60_000) {
                throw new HttpError(409, 'paid_egress_isolation_proof_required');
              }
            }
            if (livePaidEgressInFlight.has(principal.tenantId) ||
                livePaidEgressInFlight.size >= 2) {
              throw new HttpError(409, 'paid_egress_worker_capacity_exhausted');
            }
            livePaidEgressInFlight.add(principal.tenantId);
            try {
              const response = await paidEgress().execute(principal,
                body as PaidAgentInput, () => {
                  const current = getRequestSession(req.headers.cookie)?.identity;
                  if (!current || current.userId !== principal.userId ||
                      current.tenantId !== principal.tenantId ||
                      current.memberRole !== 'owner' || !identityStore().hasMfa(current)) {
                    throw new HttpError(403, 'paid_egress_identity_changed_before_send');
                  }
                });
              // The upstream may have charged even when a valid response was
              // received. Return the local hold as CASH-UNKNOWN, never paid.
              sendJson(res, 200, response);
            } catch (error) {
              if (error instanceof TenantBudgetError ||
                  error instanceof TrustedEgressError) {
                throw new HttpError(error.status, error.message);
              }
              if (error instanceof TrustedAgentProcessError) {
                throw new HttpError(503, error.reason);
              }
              throw error;
            } finally {
              livePaidEgressInFlight.delete(principal.tenantId);
            }
            return;
          }
          const cancelPaidAttempt =
            /^\/api\/identity\/paid-egress\/attempts\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
          if (cancelPaidAttempt && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            const body = await readInput();
            allowOnly(body, []);
            try {
              sendJson(res, 200, paidEgress().cancel(principal, cancelPaidAttempt[1]));
            } catch (error) {
              if (error instanceof TenantBudgetError) {
                throw new HttpError(error.status, error.message);
              }
              throw error;
            }
            return;
          }
          if (url.pathname === '/api/identity/agent-runtime/production-proof' &&
              req.method === 'GET') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'production_proof_owner_mfa_required');
            }
            const requestedId = url.searchParams.get('credentialId');
            if (requestedId !== null &&
                !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestedId)) {
              throw new HttpError(400, 'production_proof_credential_id_invalid');
            }
            const accounts = identityStore().listIndependentAccounts(principal);
            const selected = requestedId === null
              ? (accounts.length === 1 ? accounts[0] : null)
              : accounts.find(a => a.credentialId === requestedId) ?? null;
            if (requestedId !== null && !selected) {
              throw new HttpError(404, 'production_proof_account_not_found');
            }
            // This checks the deployed binary's NATIVE scope capability, not
            // source files or a synthetic environment flag. No model call,
            // subscription secret, or provider invoice is requested here.
            let magpieNativeScope = false;
            if (principal.rootAdministrator && magpie.scopeCapability) {
              try { magpieNativeScope = await magpie.scopeCapability(); }
              catch { magpieNativeScope = false; }
            }
            const current = getRequestSession(req.headers.cookie)?.identity;
            if (!current || current.userId !== principal.userId ||
                current.tenantId !== principal.tenantId ||
                current.memberRole !== 'owner' || !identityStore().hasMfa(current)) {
              throw new HttpError(403, 'production_proof_identity_changed');
            }
            const currency = selected?.provider === 'deepseek' ? 'CNY' : 'USD';
            const policy = selected ? budgetLedger().policy(current, currency) : null;
            const result = evaluateProductionProof({
              nowMs: Date.now(), tenantOwner: true, mfaEnabled: true,
              dockerIsolatedAtMs: dockerAgentProbeAt.get(current.tenantId) ?? null,
              rootAdministrator: current.rootAdministrator,
              magpiePatchedNativeScopeObserved: magpieNativeScope,
              account: selected && (selected.provider === 'deepseek' ||
                selected.provider === 'openai') ? {
                  credentialId: selected.credentialId, provider: selected.provider,
                  expiresAt: selected.expiresAt
                } : null,
              budgetConfiguredAndAvailable: !!policy?.canReservePreview,
              anyUnknownCash: budgetLedger().hasUnknownCash(current),
              officialDailyCostObservations:
                identityStore().listOfficialIssuedKeyCostObservations(current),
              officialMonthlyLimitObservations:
                identityStore().listOfficialOpenAiSpendLimits(current)
            });
            sendJson(res, 200, result);
            return;
          }
          if (url.pathname === '/api/identity/agent-runtime/governed-capabilities' &&
              req.method === 'GET') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'agent_runtime_owner_mfa_required');
            }
            sendJson(res, 200, {
              magpieSubscriptionTargetsDiscoverable: principal.rootAdministrator,
              magpieSubscriptionExecutionThroughTrustedEgress: false,
              dynamicGroupPaidDispatchEnabled: false,
              automaticTargetSelectionPreview: true,
              productionMultiturnPaidExecution: false,
              maxOfflineProtocolTurns: 4,
              allowedMemoryTools: GOVERNED_MODEL_TOOLS.map(t => t.function.name),
              toolsMayAccessNetworkOrFilesystem: false,
              cashUnknownBlocksNextPaidTurn: true,
              officialDailyKeyCostAggregationAvailable: true,
              officialPerRequestInvoiceAttributionAvailable: false,
              exactVendorCashHardCapGuaranteed: false,
              openaiDocumentedMonthlyHardSpendLimitMayOvershoot: true
            });
            return;
          }
          if (url.pathname === '/api/identity/agent-runtime/governed-route-plan' &&
              req.method === 'POST') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'agent_runtime_owner_mfa_required');
            }
            // A nonroot tenant must never get the shared Magpie owner's
            // subscription catalog or delegate its account through routing.
            if (!principal.rootAdministrator) {
              throw new HttpError(403, 'tenant_magpie_instance_not_owned');
            }
            const body = await readInput();
            allowOnly(body, ['preferredTargets']);
            if (body.preferredTargets !== undefined &&
                (!Array.isArray(body.preferredTargets) ||
                  body.preferredTargets.length > 20 ||
                  body.preferredTargets.some(v => typeof v !== 'string' || v.length > 160))) {
              throw new HttpError(400, 'governed_magpie_preference_invalid');
            }
            if (!magpie.unifiedTargets) throw new HttpError(503, 'magpie_native_catalog_unavailable');
            try {
              const catalog = await magpie.unifiedTargets();
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId ||
                  current.tenantId !== principal.tenantId ||
                  current.memberRole !== 'owner' || !current.rootAdministrator ||
                  !identityStore().hasMfa(current)) {
                throw new HttpError(403, 'governed_magpie_identity_changed');
              }
              sendJson(res, 200, planGovernedMagpieTargets(
                catalog, identityStore().listIndependentAccounts(current),
                { preferredTargets: body.preferredTargets as string[] | undefined }));
            } catch (error) {
              if (error instanceof HttpError) throw error;
              throw new HttpError(409, 'governed_magpie_route_cannot_be_proven');
            }
            return;
          }
          if (url.pathname === '/api/identity/billing/official-spend-limits' &&
              req.method === 'GET') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal))
              throw new HttpError(403, 'tenant_owner_mfa_required');
            sendJson(res, 200, {
              observations: identityStore().listOfficialOpenAiSpendLimits(principal),
              strictPerRequestCashCapGuaranteed: false,
              officialMonthlyEnforcementMayOvershoot: true,
              automaticallyUnlocksPaidDispatch: false
            });
            return;
          }
          if (url.pathname === '/api/identity/billing/official-spend-limits' &&
              req.method === 'POST') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal))
              throw new HttpError(403, 'tenant_owner_mfa_required');
            const body = await readInput();
            allowOnly(body, ['credentialId','adminKey','confirmation']);
            if (body.confirmation !== 'READ_OFFICIAL_MONTHLY_LIMITS' ||
                typeof body.credentialId !== 'string' ||
                typeof body.adminKey !== 'string' ||
                body.adminKey.length < 12 || body.adminKey.length > 4096 ||
                /[\r\n\0]/.test(body.adminKey)) {
              throw new HttpError(400, 'official_spend_limit_confirmation_invalid');
            }
            if (officialSpendLimitInFlight.has(principal.tenantId))
              throw new HttpError(409, 'official_spend_limit_read_in_progress');
            const scope = identityStore().trustedIssuedOpenAiCostScope(
              principal, body.credentialId);
            officialSpendLimitInFlight.add(principal.tenantId);
            try {
              const proof = await readOpenAiSpendLimitState({
                projectId: scope.projectId, adminKey: body.adminKey
              }, options.identityBillingReadTest);
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId ||
                  current.tenantId !== principal.tenantId ||
                  current.memberRole !== 'owner' || !identityStore().hasMfa(current)) {
                throw new HttpError(403, 'official_spend_limit_identity_changed');
              }
              const observed = identityStore().recordOfficialOpenAiSpendLimit(
                current, scope.credentialId, proof);
              sendJson(res, 201, {
                ...observed, providerMonthlyEnforcementVerified:
                  proof.providerMonthlyEnforcementVerified,
                project: proof.project, organization: proof.organization,
                effectiveMonthlyThresholdMinor: proof.effectiveMonthlyThresholdMinor,
                limitMayOvershoot: true,
                exactPerRequestCashCapVerified: false
              });
            } catch (error) {
              if (error instanceof HttpError || error instanceof IdentityError) throw error;
              if (error instanceof OfficialSpendLimitError)
                throw new HttpError(error.status, error.message);
              throw new HttpError(503, 'official_spend_limit_read_failed');
            } finally { officialSpendLimitInFlight.delete(principal.tenantId); }
            return;
          }
          if (url.pathname === '/api/identity/billing/issued-key-daily-costs' &&
              req.method === 'GET') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'tenant_owner_mfa_required');
            }
            sendJson(res, 200, {
              observations: identityStore().listOfficialIssuedKeyCostObservations(principal),
              authoritativeAdminAggregate: true, authenticatedVendorInvoice: false,
              perRequestCashSettlement: false, releasesUnknownHolds: false
            });
            return;
          }
          if (url.pathname === '/api/identity/billing/issued-key-daily-costs' &&
              req.method === 'POST') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'tenant_owner_mfa_required');
            }
            const body = await readInput();
            allowOnly(body, ['credentialId','adminKey','confirmation']);
            if (body.confirmation !== 'READ_OFFICIAL_KEY_SCOPED_COSTS' ||
                typeof body.credentialId !== 'string' ||
                typeof body.adminKey !== 'string' || body.adminKey.length < 12 ||
                body.adminKey.length > 4096 || /[\r\n\0]/.test(body.adminKey)) {
              throw new HttpError(400, 'official_cost_confirmation_or_input_invalid');
            }
            if (officialIssuedKeyCostInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'official_cost_read_in_progress');
            }
            const scope = identityStore().trustedIssuedOpenAiCostScope(
              principal, body.credentialId);
            officialIssuedKeyCostInFlight.add(principal.tenantId);
            try {
              const observed = await readOpenAiIssuedKeyDailyCost({
                projectId: scope.projectId, keyId: scope.keyId,
                adminKey: body.adminKey
              }, options.identityBillingReadTest);
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId ||
                  current.tenantId !== principal.tenantId ||
                  current.memberRole !== 'owner' || !identityStore().hasMfa(current)) {
                throw new HttpError(403, 'official_cost_identity_changed');
              }
              const item = identityStore().recordOfficialIssuedKeyDailyCost(
                current, scope.credentialId, observed);
              sendJson(res, 201, {
                ...item, exactCashCapVerified: false,
                monthlyProviderHardLimitVerified: false,
                officialAggregateObserved: true
              });
            } catch (error) {
              if (error instanceof HttpError || error instanceof IdentityError) throw error;
              if (error instanceof OfficialCostEvidenceError) {
                throw new HttpError(error.status, error.message);
              }
              throw new HttpError(503, 'official_cost_read_failed');
            } finally { officialIssuedKeyCostInFlight.delete(principal.tenantId); }
            return;
          }
          if (url.pathname === '/api/identity/agent-runtime/readiness' && req.method === 'GET') {
            if (principal.memberRole !== 'owner' || !identityStore().hasMfa(principal)) {
              throw new HttpError(403, 'agent_runtime_owner_mfa_required');
            }
            const base = identityStore().productionReadiness(principal);
            const policies = budgetLedger().policies(principal);
            const accounts = identityStore().listIndependentAccounts(principal);
            const at = dockerAgentProbeAt.get(principal.tenantId);
            const isolated = at !== undefined && Date.now() >= at &&
              Date.now() - at < 5 * 60_000;
            const validAccounts = accounts.filter(a => Date.parse(a.expiresAt) > Date.now());
            const blockers = [
              ...base.blockers,
              ...(!isolated ? ['docker_agent_isolation_proof_missing_or_expired'] : []),
              ...(validAccounts.length === 0 ? ['no_recent_independent_tenant_key'] : []),
              ...(policies.length === 0 ? ['tenant_cash_budget_not_configured'] : []),
              'tenant_budget_preview_is_not_vendor_hard_cap',
              ...(paidEgress().availableForManualOneShot
                ? ['trusted_egress_manual_one_shot_only']
                : ['trusted_egress_disabled_by_default']),
              'vendor_invoice_and_key_project_link_not_verified'
            ];
            sendJson(res, 200, {
              tenantId: principal.tenantId,
              dockerOfflineIsolationVerified: isolated,
              isolatedProofExpiresAt: isolated ? new Date(at! + 5 * 60_000).toISOString() : null,
              validIndependentAccountCount: validAccounts.length,
              budgetCurrencyPolicies: policies.map(p => p.currency),
              manualOneShotEgressEnabled: paidEgress().availableForManualOneShot,
              manualOneShotReady: isolated && paidEgress().availableForManualOneShot &&
                validAccounts.some(account => policies.some(policy =>
                  policy.currency === (account.provider === 'openai' ? 'USD' : 'CNY') &&
                  policy.canReservePreview)),
              credentialExposed: false, vendorAccountUsed: false,
              productionPaidAgentReady: false, paidDispatchPermitted: false,
              vendorGuaranteedCashCap: false, invoiceReconciliationVerified: false,
              blockers: [...new Set(blockers)]
            });
            return;
          }
          if (url.pathname === '/api/identity/readiness' && req.method === 'GET') {
            sendJson(res, 200, identityStore().productionReadiness(principal));
            return;
          }
          if (url.pathname === '/api/identity/mfa/status' && req.method === 'GET') {
            sendJson(res, 200, { enabled: identityStore().hasMfa(principal), requiredForWrites: true });
            return;
          }
          if (url.pathname === '/api/identity/mfa/begin' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['password']);
            sendJson(res, 200, await identityStore().beginMfaEnrollment(principal, req.headers.cookie, body.password));
            return;
          }
          if (url.pathname === '/api/identity/mfa/confirm' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['code']);
            sendJson(res, 200, identityStore().confirmMfaEnrollment(principal, req.headers.cookie, body.code));
            return;
          }
          if (url.pathname === '/api/identity/me' && req.method === 'GET') {
            sendJson(res, 200, { identity: principal, tenants: identityStore().listTenants(principal) });
            return;
          }
          if (url.pathname === '/api/identity/logout' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, []);
            identityStore().logout(req.headers.cookie);
            res.setHeader('Set-Cookie', 'daming_identity=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
            sendJson(res, 200, { loggedOut: true });
            return;
          }
          if (url.pathname === '/api/identity/tenants' && req.method === 'GET') {
            sendJson(res, 200, { tenants: identityStore().listTenants(principal) });
            return;
          }
          if (url.pathname === '/api/identity/members' && req.method === 'GET') {
            sendJson(res, 200, { members: identityStore().listMembers(principal) });
            return;
          }
          const memberRemoval = /^\/api\/identity\/members\/([a-f0-9-]{36})$/.exec(url.pathname);
          if (memberRemoval && req.method === 'DELETE') {
            identityStore().removeMember(principal, memberRemoval[1]);
            sendJson(res, 200, { removed: true });
            return;
          }
          if (url.pathname === '/api/identity/audit' && req.method === 'GET') {
            sendJson(res, 200, { events: identityStore().auditFor(principal) });
            return;
          }
          if (url.pathname === '/api/identity/tenants' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['name']);
            sendJson(res, 201, identityStore().createTenant(principal, body.name));
            return;
          }
          if (url.pathname === '/api/identity/switch-tenant' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['tenantId']);
            const changed = identityStore().switchTenant(principal, body.tenantId, req.headers.cookie);
            issueIdentityCookie(changed.cookie, changed.session);
            return;
          }
          if (url.pathname === '/api/identity/invitations' && req.method === 'POST') {
            const body = await readInput();
            allowOnly(body, ['role']);
            sendJson(res, 201, identityStore().issueInvitation(principal, body.role));
            return;
          }
          if (url.pathname === '/api/identity/tenant-accounts' && req.method === 'GET') {
            sendJson(res, 200, { accounts: identityStore().listIndependentAccounts(principal) });
            return;
          }
          if (url.pathname === '/api/identity/tenant-accounts' && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
            const input = await readInput();
            allowOnly(input, ['provider', 'modelId', 'apiKey', 'label']);
            if ((input.provider !== 'deepseek' && input.provider !== 'openai') ||
                typeof input.modelId !== 'string' || typeof input.apiKey !== 'string' ||
                typeof input.label !== 'string' ||
                !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/.test(input.modelId) ||
                input.apiKey.length < 12 || input.apiKey.length > 4096 ||
                /[\r\n\0]/.test(input.apiKey)) throw new HttpError(400, 'tenant_key_invalid');
            if (credentialProofInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'credential_verification_in_progress');
            }
            credentialProofInFlight.add(principal.tenantId);
            try {
              let verified = false;
              try {
                verified = await (options.identityProofTest?.verifyVendor ??
                  verifyVendorKeyControl)(input.provider, input.apiKey, input.modelId);
              } catch { /* deny */ }
              if (!verified) throw new HttpError(422, 'official_vendor_model_key_unverified');
              const still = getRequestSession(req.headers.cookie)?.identity;
              if (!still || still.userId !== principal.userId ||
                  still.tenantId !== principal.tenantId ||
                  still.memberRole !== 'owner' || !identityStore().hasMfa(still)) {
                throw new HttpError(403, 'tenant_identity_changed_during_verification');
              }
              sendJson(res, 201, identityStore().registerIndependentAccount(still, {
                provider: input.provider, modelId: input.modelId,
                apiKey: input.apiKey, label: input.label
              }));
            } finally { credentialProofInFlight.delete(principal.tenantId); }
            return;
          }
          const independentReverify =
            /^\/api\/identity\/tenant-accounts\/([a-f0-9-]{36})\/verify$/.exec(url.pathname);
          if (independentReverify && req.method === 'POST') {
            const input = await readInput();
            allowOnly(input, ['apiKey']);
            if (typeof input.apiKey !== 'string' || input.apiKey.length < 12 ||
                input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) {
              throw new HttpError(400, 'tenant_key_invalid');
            }
            const held = identityStore().independentAccountForVerification(
              principal, independentReverify[1]);
            if (!held) throw new HttpError(404, 'tenant_account_not_found');
            if (credentialProofInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'credential_verification_in_progress');
            }
            credentialProofInFlight.add(principal.tenantId);
            try {
              let verified = false;
              try {
                verified = await (options.identityProofTest?.verifyVendor ??
                  verifyVendorKeyControl)(held.provider, input.apiKey, held.modelId);
              } catch { /* deny */ }
              if (!verified) throw new HttpError(422, 'official_vendor_model_key_unverified');
              const still = getRequestSession(req.headers.cookie)?.identity;
              if (!still || still.userId !== principal.userId ||
                  still.tenantId !== principal.tenantId ||
                  still.memberRole !== 'owner' || !identityStore().hasMfa(still)) {
                throw new HttpError(403, 'tenant_identity_changed_during_verification');
              }
              sendJson(res, 200, identityStore().renewIndependentAccount(
                still, independentReverify[1], input.apiKey));
            } finally { credentialProofInFlight.delete(principal.tenantId); }
            return;
          }
          const independentRevoke =
            /^\/api\/identity\/tenant-accounts\/([a-f0-9-]{36})$/.exec(url.pathname);
          if (independentRevoke && req.method === 'DELETE') {
            identityStore().revokeIndependentAccount(principal, independentRevoke[1]);
            sendJson(res, 200, { revoked: true });
            return;
          }

          if (url.pathname === '/api/identity/billing/observations' && req.method === 'GET') {
            sendJson(res, 200, { observations: identityStore().listBillingObservations(principal) });
            return;
          }
          if (url.pathname === '/api/identity/billing/probe' && req.method === 'POST') {
            if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
            const input = await readInput();
            allowOnly(input, ['credentialId', 'provider', 'apiKey', 'adminKey', 'projectId']);
            if (typeof input.credentialId !== 'string' ||
                (input.provider !== 'openai' && input.provider !== 'deepseek')) {
              throw new HttpError(400, 'billing_probe_input_invalid');
            }
            const bound = identityStore().accountForVerification(principal, input.credentialId);
            if (!bound || bound.providerKind !== input.provider) {
              throw new HttpError(404, 'billing_credential_not_found');
            }
            if (billingObservationInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'billing_probe_already_running');
            }
            billingObservationInFlight.add(principal.tenantId);
            try {
              const current = identityStore();
              let observation;
              if (input.provider === 'deepseek') {
                if (typeof input.apiKey !== 'string' ||
                    input.adminKey !== undefined || input.projectId !== undefined) {
                  throw new HttpError(400, 'deepseek_balance_request_invalid');
                }
                current.assertSubmittedKey(principal, input.credentialId, input.apiKey, 'deepseek');
                observation = await probeDeepSeekBalance(input.apiKey, options.identityBillingReadTest);
              } else {
                if (typeof input.adminKey !== 'string' ||
                    typeof input.projectId !== 'string' || input.apiKey !== undefined) {
                  throw new HttpError(400, 'openai_admin_cost_request_invalid');
                }
                observation = await probeOpenAiProjectCost(
                  input.adminKey, input.projectId, Date.now(), options.identityBillingReadTest);
              }
              // External reads are slow: both membership AND the specific
              // credential must remain valid before persisting anything.
              const still = getRequestSession(req.headers.cookie)?.identity;
              if (!still || still.userId !== principal.userId ||
                  still.tenantId !== principal.tenantId ||
                  still.memberRole !== 'owner' || !identityStore().hasMfa(still)) {
                throw new HttpError(403, 'billing_identity_changed_during_probe');
              }
              sendJson(res, 201, current.recordBillingObservation(
                still, input.credentialId, observation));
            } catch (error) {
              if (error instanceof BillingProbeError) {
                throw new HttpError(error.status, error.message);
              }
              throw error;
            } finally {
              billingObservationInFlight.delete(principal.tenantId);
            }
            return;
          }
          if (url.pathname === '/api/identity/accounts' && req.method === 'GET') {
            sendJson(res, 200, { accounts: identityStore().listAccounts(principal) });
            return;
          }
          if (url.pathname === '/api/identity/candidates' && req.method === 'GET') {
            if (!principal.rootAdministrator) throw new HttpError(403, 'shared_magpie_root_only');
            if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
            let catalog: MagpieRoutingCatalog | undefined;
            try { catalog = await magpie.routingCatalog?.(); } catch { /* do not disclose raw error */ }
            sendJson(res, 200, publicMagpieRoutingCatalog(catalog ?? null));
            return;
          }
          if (url.pathname === '/api/identity/accounts' && req.method === 'POST') {
            if (!principal.rootAdministrator) throw new HttpError(403, 'shared_magpie_root_only');
            if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
            const body = await readInput();
            allowOnly(body, ['candidateId', 'providerKind', 'apiKey', 'label']);
            if (typeof body.candidateId !== 'string' ||
                (body.providerKind !== 'openai' && body.providerKind !== 'deepseek') ||
                typeof body.apiKey !== 'string' || body.apiKey.length < 12 || body.apiKey.length > 4096 ||
                /[\r\n\0]/.test(body.apiKey) || typeof body.label !== 'string') {
              throw new HttpError(400, 'credential_registration_invalid');
            }
            let catalog: MagpieRoutingCatalog;
            try { catalog = await magpie.routingCatalog?.() ?? (() => { throw new Error('not_ready'); })(); }
            catch { throw new HttpError(503, 'route_catalog_unavailable'); }
            const candidate = catalog.candidates.find(c => c.candidateId === body.candidateId);
            if (!candidate) throw new HttpError(409, 'route_candidate_not_available');
            const binding: CredentialBinding = {
              instanceId: catalog.instanceId, providerId: candidate.providerId, accountRef: candidate.accountRef
            };
            const vendor = body.providerKind as ProviderKind;
            if (credentialProofInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'credential_verification_in_progress');
            }
            credentialProofInFlight.add(principal.tenantId);
            try {
            let matched = false;
            try {
              matched = await (options.identityProofTest?.matchMagpie ??
                magpie.provePinnedCredential?.bind(magpie) ??
                (async () => false))(binding, vendor, body.apiKey);
            } catch { matched = false; }
            if (!matched) throw new HttpError(422, 'credential_not_equal_to_magpie_key_or_unsupported_endpoint');
            let controlVerified = false;
            try {
              controlVerified = await (options.identityProofTest?.verifyVendor ??
                verifyVendorKeyControl)(vendor, body.apiKey, candidate.modelId);
            } catch { controlVerified = false; }
            if (!controlVerified) throw new HttpError(422, 'vendor_key_control_verification_failed');
            // Re-check identity and the exact account mapping after the
            // network operation; never approve a rotated key or revoked user.
            const still = getRequestSession(req.headers.cookie)?.identity;
            if (!still || still.userId !== principal.userId || still.tenantId !== principal.tenantId ||
                still.memberRole !== 'owner') throw new HttpError(403, 'identity_changed_during_verification');
            let refreshed: MagpieRoutingCatalog | undefined;
            try { refreshed = await magpie.routingCatalog?.(); } catch { /* fail closed */ }
            if (!refreshed || refreshed.instanceId !== catalog.instanceId ||
                !refreshed.candidates.some(c => c.candidateId === candidate.candidateId &&
                  c.providerId === candidate.providerId && c.accountRef === candidate.accountRef)) {
              throw new HttpError(409, 'route_binding_changed_during_verification');
            }
            sendJson(res, 201, identityStore().registerAccount(principal, {
              candidate, instanceId: binding.instanceId,
              providerKind: vendor, label: body.label, secret: body.apiKey
            }));
            liveEvents.publish('missions');
            return;
            } finally { credentialProofInFlight.delete(principal.tenantId); }
          }
          const accountReverify = /^\/api\/identity\/accounts\/([a-f0-9-]{36})\/verify$/.exec(url.pathname);
          if (accountReverify && req.method === 'POST') {
            if (!principal.rootAdministrator) throw new HttpError(403, 'shared_magpie_root_only');
            const body = await readInput();
            allowOnly(body, ['candidateId', 'apiKey']);
            if (typeof body.candidateId !== 'string' || typeof body.apiKey !== 'string' ||
                body.apiKey.length < 12 || body.apiKey.length > 4096 || /[\r\n\0]/.test(body.apiKey)) {
              throw new HttpError(400, 'credential_registration_invalid');
            }
            const held = identityStore().accountForVerification(principal, accountReverify[1]);
            if (!held) throw new HttpError(404, 'credential_not_found');
            if (credentialProofInFlight.has(principal.tenantId)) {
              throw new HttpError(409, 'credential_verification_in_progress');
            }
            credentialProofInFlight.add(principal.tenantId);
            try {
              let live: MagpieRoutingCatalog;
              try { live = await magpie.routingCatalog?.() ?? (() => { throw new Error('offline'); })(); }
              catch { throw new HttpError(503, 'route_catalog_unavailable'); }
              const candidate = live.candidates.find(c => c.candidateId === body.candidateId &&
                c.accountRef === held.accountRef && c.providerId === held.providerId);
              if (live.instanceId !== held.instanceId || !candidate) {
                throw new HttpError(409, 'route_binding_changed_during_verification');
              }
              const proof = options.identityProofTest?.matchMagpie ?? magpie.provePinnedCredential?.bind(magpie);
              if (!proof || !await proof(held, held.providerKind, body.apiKey)) {
                throw new HttpError(422, 'credential_not_equal_to_magpie_key_or_unsupported_endpoint');
              }
              const verify = options.identityProofTest?.verifyVendor ?? verifyVendorKeyControl;
              if (!await verify(held.providerKind, body.apiKey, candidate.modelId)) {
                throw new HttpError(422, 'vendor_key_control_verification_failed');
              }
              const current = getRequestSession(req.headers.cookie)?.identity;
              if (!current || current.userId !== principal.userId || current.tenantId !== principal.tenantId ||
                  current.memberRole !== 'owner') throw new HttpError(403, 'identity_changed_during_verification');
              let refreshed: MagpieRoutingCatalog | undefined;
              try { refreshed = await magpie.routingCatalog?.(); } catch { /* fail closed */ }
              if (!refreshed || refreshed.instanceId !== live.instanceId ||
                  !refreshed.candidates.some(c => c.candidateId === candidate.candidateId &&
                    c.accountRef === candidate.accountRef && c.providerId === candidate.providerId)) {
                throw new HttpError(409, 'route_binding_changed_during_verification');
              }
              sendJson(res, 200, identityStore().reverifyAccount(principal, accountReverify[1], body.apiKey));
              return;
            } finally { credentialProofInFlight.delete(principal.tenantId); }
          }
          const credentialMatch = /^\/api\/identity\/accounts\/([a-f0-9-]{36})$/.exec(url.pathname);
          if (credentialMatch && req.method === 'DELETE') {
            identityStore().revokeAccount(principal, credentialMatch[1]);
            liveEvents.publish('missions');
            sendJson(res, 200, { revoked: true });
            return;
          }
          throw new HttpError(404, 'not_found');
        }
        // Legacy tasks, Magpie admin, plugins and CLI execution are still
        // host-global. Never let an invited tenant member see or mutate them.
        if (initialized && !principal?.rootAdministrator &&
            !url.pathname.startsWith('/api/command/') &&
            !url.pathname.startsWith('/api/tasks') && !identityPath) {
          throw new HttpError(403, 'shared_host_api_owner_only');
        }
        if (initialized && !principal?.rootAdministrator && url.pathname.startsWith('/api/command/')) {
          // The Autoloop decision engine, Magpie router, key scope issuance,
          // plugin manager and worker processes still have Host-global state.
          // Only the following *read-only* tenant-aware projections are safe.
          const safeCommandRead = req.method === 'GET' && (
            url.pathname === '/api/command/missions' ||
            url.pathname === '/api/command/routes' ||
            /^\/api\/command\/missions\/[a-f0-9-]{36}(?:\/notification-preview|\/route-preflight)?$/.test(url.pathname)
          );
          if (!safeCommandRead) throw new HttpError(403, 'tenant_shared_command_execution_not_isolated');
        }
        const codexWebMatch = /^\/api\/codex-subscription\/tasks(?:\/([a-f0-9-]{36})(?:\/(approve|cancel))?)?$/.exec(url.pathname);
        if (url.pathname.startsWith('/api/codex-subscription/')) {
          if (!initialized || !principal?.rootAdministrator || session.role !== 'readwrite' || !identityStore().hasMfa(principal)) {
            throw new HttpError(403, 'codex_web_mfa_root_required');
          }
          if (!codexWebMatch) throw new HttpError(404, 'not_found');
          const actor = { tenantId: principal.tenantId, userId: principal.userId, sessionId: session.id };
          const assertCurrent = () => {
            const active = getRequestSession(req.headers.cookie);
            if (!active || active.id !== actor.sessionId || active.role !== 'readwrite' ||
                active.identity?.userId !== actor.userId || active.identity?.tenantId !== actor.tenantId ||
                !active.identity.rootAdministrator || !identityStore().hasMfa(active.identity)) {
              throw new HttpError(403, 'codex_web_session_changed');
            }
          };
          const id = codexWebMatch[1], action = codexWebMatch[2];
          try {
            if (req.method === 'GET' && !action) {
              sendJson(res, 200, id ? codexWeb!.detail(actor, id) : { tasks: codexWeb!.list(actor) }); return;
            }
            if (req.method === 'POST') {
              const body = await readInput(32768); assertCurrent();
              if (!id) {
                allowOnly(body, ['requestId', 'prompt', 'limitMinor']);
                const task = await codexWeb!.prepare(actor, body as unknown as { requestId: string; prompt: string; limitMinor: number }, assertCurrent);
                identityStore().bindTask(principal, task.taskId, 'real');
                sendJson(res, 201, task); return;
              }
              if (action === 'approve') {
                allowOnly(body, ['approvedMaximumMinor']);
                sendJson(res, 202, await codexWeb!.approve(actor, id, body.approvedMaximumMinor as number, assertCurrent)); return;
              }
              if (action === 'cancel') {
                allowOnly(body, []); sendJson(res, 200, codexWeb!.cancel(actor, id)); return;
              }
            }
          } catch (error) {
            if (error instanceof CodexApprovalError) throw new HttpError(error.status, error.message);
            throw error;
          }
          throw new HttpError(404, 'not_found');
        }
        const genericTask = /^\/api\/tasks\/([^/]+)(?:\/|$)/.exec(url.pathname);
        const scopedTask = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/|$)/.exec(url.pathname);
        if (initialized && scopedTask && principal) {
          identityStore().assertTask(principal, scopedTask[1]);
          if (!principal.rootAdministrator && identityStore().taskMode(principal, scopedTask[1]) !== 'fixture') {
            throw new HttpError(403, 'tenant_task_mode_not_enabled');
          }
        }
        if (genericTask && store!.getTask(decodeURIComponent(genericTask[1]))?.sourceId === CODEX_WEB_SOURCE) {
          if (initialized && principal) identityStore().assertTask(principal, decodeURIComponent(genericTask[1]));
          throw new HttpError(409, 'codex_web_use_dedicated_endpoint');
        }
        const scopedMission = /^\/api\/command\/missions\/([a-f0-9-]{36})(?:\/|$)/.exec(url.pathname);
        if (initialized && scopedMission && principal) {
          identityStore().assertMission(principal, scopedMission[1]);
        }
        const agentGraphMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/agent-graph(?:\/(launch|decide))?$/.exec(url.pathname);
        if (agentGraphMatch) {
          if (!initialized || !principal?.rootAdministrator ||
              !identityStore().hasMfa(principal)) {
            throw new HttpError(403, 'agent_graph_root_mfa_required');
          }
          const missionId = agentGraphMatch[1], action = agentGraphMatch[2];
          identityStore().assertMission(principal, missionId);
          try {
            if (req.method === 'GET' && !action) {
              sendJson(res, 200, { graph: agentGraph.latest(missionId, principal.tenantId) });
              return;
            }
            if (req.method === 'POST' && action === 'launch') {
              const body = await readInput();
              const active = getRequestSession(req.headers.cookie)?.identity;
              if (!active || active.userId !== principal.userId ||
                  active.tenantId !== principal.tenantId || !active.rootAdministrator ||
                  !identityStore().hasMfa(active)) {
                throw new HttpError(403, 'agent_launch_session_changed');
              }
              allowOnly(body, ['requestId']);
              if (typeof body.requestId !== 'string') {
                throw new HttpError(400, 'agent_launch_request_invalid');
              }
              const mission = missionControl.detail(missionId);
              if (mission.status === 'blocked' || mission.status === 'cancelled' ||
                  mission.status === 'completed') {
                throw new HttpError(409, 'mission_not_available_for_orchestration');
              }
              const targets: { research?: string; analysis?: string } = {};
              for (const node of mission.nodes) {
                if (node.id === 'research' || node.id === 'analysis') {
                  targets[node.id] = node.modelRoute;
                }
              }
              const graph = agentGraph.create({
                tenantId: principal.tenantId, userId: principal.userId, missionId,
                requestId: body.requestId, goal: mission.goal, plannedTargets: targets
              });
              // Work is dispatched *after* the durable SQLite graph/receipt.
              // No selected Magpie target is invoked by this offline adapter.
              void agentGraph.dispatch(graph.rootRunId, principal.tenantId).catch(() => undefined);
              sendJson(res, 201, { graph });
              return;
            }
            if (req.method === 'POST' && action === 'decide') {
              const body = await readInput();
              const active = getRequestSession(req.headers.cookie)?.identity;
              if (!active || active.userId !== principal.userId ||
                  active.tenantId !== principal.tenantId || !active.rootAdministrator ||
                  !identityStore().hasMfa(active)) {
                throw new HttpError(403, 'agent_decision_session_changed');
              }
              allowOnly(body, ['runId', 'requestId', 'action']);
              if (typeof body.runId !== 'string' || typeof body.requestId !== 'string' ||
                  (body.action !== 'approve' && body.action !== 'cancel')) {
                throw new HttpError(400, 'agent_decision_input_invalid');
              }
              // Scope-check the run before changing ANY state. A valid run ID
              // from another mission in the same tenant grants no permission.
              if (agentGraph.graph(body.runId, principal.tenantId).missionId !== missionId) {
                throw new HttpError(404, 'agent_run_not_found');
              }
              const graph = agentGraph.decide(principal.tenantId, body.runId,
                body.requestId, body.action);
              sendJson(res, 200, { graph });
              return;
            }
          } catch (error) {
            if (error instanceof AgentGraphError) {
              throw new HttpError(error.status, error.message);
            }
            throw error;
          }
          throw new HttpError(404, 'not_found');
        }
        if (url.pathname === '/api/command/missions' && req.method === 'GET') {
          sendJson(res, 200, { missions: initialized && principal
            ? missionControl.list().filter(m => identityStore().ownsMission(principal, m.missionId))
            : missionControl.list() });
          return;
        }
        if (url.pathname === '/api/command/resources' && req.method === 'GET') {
          let configured = false;
          try { configured = (await magpie.status()).configured; } catch { /* unavailable */ }
          const fetched = configured
            ? await Promise.allSettled(['models','providers','agents','quotas'].map((alias) => magpie.read(alias)))
            : [];
          const get = (index: number): MagpieReadView | undefined => {
            const answer = fetched[index];
            return answer?.status === 'fulfilled' ? answer.value : undefined;
          };
          const models = get(0), providers = get(1), agents = get(2), quotas = get(3);
          const resources: MissionResourceView = {
            source: 'magpie', configured,
            status: configured ? 'inventory_ready' : 'unavailable',
            models: { count: models?.count ?? null, sample: (models?.labels ?? []).slice(0, 6) },
            providers: { count: providers?.count ?? null,
              ready: providers?.items.filter((item) => item.status === 'ready').length ?? 0 },
            agents: { count: agents?.count ?? null, sample: (agents?.labels ?? []).slice(0, 6) },
            quotas: { count: quotas?.count ?? null },
            credentialsExposed: false, dispatchEnabled: false
          };
          sendJson(res, 200, resources);
          return;
        }
        if (url.pathname === '/api/command/targets' && req.method === 'GET') {
          if (!initialized || !principal?.rootAdministrator) {
            throw new HttpError(403, 'magpie_targets_root_only');
          }
          try {
            if (!magpie.unifiedTargets) throw new Error('not_supported');
            sendJson(res, 200, await magpie.unifiedTargets());
          } catch { throw new HttpError(503, 'magpie_native_catalog_unavailable'); }
          return;
        }
        const rolePlanMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/role-plan$/.exec(url.pathname);
        if (rolePlanMatch && req.method === 'POST') {
          if (!initialized || !principal?.rootAdministrator) {
            throw new HttpError(403, 'magpie_targets_root_only');
          }
          identityStore().assertMission(principal, rolePlanMatch[1]);
          const input = await readInput();
          allowOnly(input, ['requestId', 'assignments']);
          if (typeof input.requestId !== 'string' || !magpie.unifiedTargets) {
            throw new HttpError(400, 'magpie_role_plan_invalid');
          }
          let catalog;
          try { catalog = await magpie.unifiedTargets(); }
          catch { throw new HttpError(503, 'magpie_native_catalog_unavailable'); }
          // Reading a native catalog is asynchronous; a session may be revoked
          // or switched to another tenant while Magpie answers.
          const still = getRequestSession(req.headers.cookie)?.identity;
          if (!still || still.userId !== principal.userId ||
              still.tenantId !== principal.tenantId || !still.rootAdministrator ||
              !identityStore().hasMfa(still)) {
            throw new HttpError(403, 'magpie_role_plan_identity_changed');
          }
          let assignments;
          try { assignments = validateMagpieRoleAssignments(input.assignments, catalog); }
          catch { throw new HttpError(400, 'magpie_role_plan_invalid'); }
          sendJson(res, 200, missionControl.assignMagpieRoles(
            rolePlanMatch[1], input.requestId, assignments));
          return;
        }
        if (url.pathname === '/api/command/routes' && req.method === 'GET') {
          let catalog: MagpieRoutingCatalog | null = null;
          try { catalog = await magpie.routingCatalog?.() ?? null; } catch { /* fail closed */ }
          sendJson(res, 200, publicMagpieRoutingCatalog(
            catalog && initialized && principal ? identityStore().filterCatalog(principal, catalog) : catalog
          ));
          return;
        }
        // ── S8 统筹页：统一模型目录 + 选模型绑定 Agent（脱敏、按租户隔离；写需非 viewer）──
        if (url.pathname === '/api/model-binding' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          let available: AvailableModelsView;
          try {
            if (!magpie.unifiedTargets) throw new Error('not_supported');
            const catalog = await magpie.unifiedTargets();
            let quotas: { providerId: string; remainingPercent?: number; resetsAt?: string }[] = [];
            try {
              const read = await magpie.read('quotas') as unknown as { items?: readonly { id?: string; remainingPercent?: number; resetsAt?: string }[] };
              if (read && Array.isArray(read.items)) {
                quotas = read.items.filter((item) => typeof item.id === 'string').map((item) => ({
                  providerId: item.id as string,
                  ...(typeof item.remainingPercent === 'number' ? { remainingPercent: item.remainingPercent } : {}),
                  ...(typeof item.resetsAt === 'string' ? { resetsAt: item.resetsAt } : {})
                }));
              }
            } catch { quotas = []; }
            available = listAvailableModels({ tenantId: principal.tenantId, source: { catalog: catalog as never, ...(quotas.length ? { quotas } : {}) } });
          } catch {
            available = { tenantId: principal.tenantId, models: [], checkedAt: new Date().toISOString(), dispatchEnabled: false };
          }
          sendJson(res, 200, { catalog: mergePlatformModels(available), bindings: modelBindings().list(principal.tenantId) });
          return;
        }
        if (url.pathname === '/api/model-binding/bind' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(32768);
          allowOnly(body, ['agent', 'modelId', 'scope']);
          const available = await availableCatalog(principal.tenantId);
          try {
            const binding = modelBindings().bind({ tenantId: principal.tenantId, agent: body.agent as never, modelId: body.modelId as string, scope: body.scope as never }, available);
            liveEvents.publish('missions');
            sendJson(res, 201, binding);
          } catch (error) {
            if (error instanceof ModelBindingError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'model_binding_input_invalid');
          }
          return;
        }
        const modelBindingRevokeMatch = /^\/api\/model-binding\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (modelBindingRevokeMatch && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          try { sendJson(res, 200, modelBindings().revoke(principal.tenantId, modelBindingRevokeMatch[1])); liveEvents.publish('missions'); }
          catch (error) { if (error instanceof ModelBindingError) throw new HttpError(error.status, error.message); throw error; }
          return;
        }
        // ── Agent 工作群：把 Agent 拉进一个群，互相讨论、用户可见、可增删、可插话指导 ──
        const isRoomMember = (value: unknown): value is RoomMember => {
          if (!value || typeof value !== 'object') return false;
          const record = value as Record<string, unknown>;
          return typeof record.agentId === 'string' && !!record.agentId && typeof record.name === 'string' && typeof record.runtime === 'string';
        };
        if (url.pathname === '/api/rooms' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { rooms: agentRooms().list() });
          return;
        }
        if (url.pathname === '/api/rooms' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(65536);
          allowOnly(body, ['title', 'members']);
          const members = Array.isArray(body.members) ? body.members.filter(isRoomMember) : [];
          const room = agentRooms().create({ ...(typeof body.title === 'string' ? { title: body.title } : {}), members });
          liveEvents.publish('agents', 'room-created');
          sendJson(res, 201, { room });
          return;
        }
        const roomOne = /^\/api\/rooms\/([a-z0-9-]+)$/.exec(url.pathname);
        if (roomOne && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const room = agentRooms().get(roomOne[1]!);
          if (!room) throw new HttpError(404, 'room_not_found');
          sendJson(res, 200, { room });
          return;
        }
        if (roomOne && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const removed = agentRooms().removeRoom(roomOne[1]!);
          if (!removed) throw new HttpError(404, 'room_not_found');
          liveEvents.publish('agents', 'room-removed');
          sendJson(res, 200, { removed: true });
          return;
        }
        if (roomOne && req.method === 'PATCH') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(8192);
          allowOnly(body, ['title']);
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!title) throw new HttpError(400, 'room_title_required');
          if (title.length > 80) throw new HttpError(400, 'room_title_too_long');
          const room = agentRooms().rename(roomOne[1]!, title);
          if (!room) throw new HttpError(404, 'room_not_found');
          liveEvents.publish('agents', 'room-renamed');
          sendJson(res, 200, { room });
          return;
        }
        const roomMembers = /^\/api\/rooms\/([a-z0-9-]+)\/members$/.exec(url.pathname);
        if (roomMembers && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(16384);
          allowOnly(body, ['agentId', 'name', 'runtime', 'providerId', 'modelId']);
          const member: RoomMember = {
            agentId: String(body.agentId ?? ''), name: String(body.name ?? body.agentId ?? ''), runtime: String(body.runtime ?? ''),
            ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
            ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {})
          };
          if (!isRoomMember(member)) throw new HttpError(400, 'room_member_invalid');
          const room = agentRooms().addMember(roomMembers[1]!, member);
          if (!room) throw new HttpError(404, 'room_not_found');
          liveEvents.publish('agents', 'room-member');
          sendJson(res, 200, { room });
          return;
        }
        if (roomMembers && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const memberId = url.searchParams.get('id') ?? '';
          if (!memberId) throw new HttpError(400, 'room_member_id_required');
          const room = agentRooms().removeMember(roomMembers[1]!, memberId);
          if (!room) throw new HttpError(404, 'room_not_found');
          liveEvents.publish('agents', 'room-member');
          sendJson(res, 200, { room });
          return;
        }
        const roomMessages = /^\/api\/rooms\/([a-z0-9-]+)\/messages$/.exec(url.pathname);
        if (roomMessages && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(65536);
          allowOnly(body, ['text', 'discuss']);
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) throw new HttpError(400, 'room_message_required');
          if (!agentRooms().get(roomMessages[1]!)) throw new HttpError(404, 'room_not_found');
          agentRooms().postMessage(roomMessages[1]!, { role: 'user', name: '我', text });
          const room = body.discuss === true ? await discussRoom(agentRooms(), roomMessages[1]!, fixtureRoomResponder) : agentRooms().get(roomMessages[1]!);
          liveEvents.publish('agents', 'room-message');
          sendJson(res, 200, { room });
          return;
        }
        const roomDiscuss = /^\/api\/rooms\/([a-z0-9-]+)\/discuss$/.exec(url.pathname);
        if (roomDiscuss && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          if (!agentRooms().get(roomDiscuss[1]!)) throw new HttpError(404, 'room_not_found');
          const room = await discussRoom(agentRooms(), roomDiscuss[1]!, fixtureRoomResponder);
          liveEvents.publish('agents', 'room-discuss');
          sendJson(res, 200, { room });
          return;
        }
        if (url.pathname === '/api/crew' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { plans: crewPlans().list() });
          return;
        }
        if (url.pathname === '/api/crew/overview' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const blockedReasons: Record<string, string | null> = {};
          const tasks = routes.list();
          for (const task of tasks) {
            if (task.status !== 'blocked') continue;
            blockedReasons[task.taskId] = routes.detail(task.taskId)?.blockedReason ?? null;
          }
          sendJson(res, 200, buildCrewOverview({
            plans: crewPlans().list(), tasks, blockedReasons, generatedAt: new Date().toISOString()
          }));
          return;
        }
        if (url.pathname === '/api/crew/plan' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(32768);
          allowOnly(body, ['title', 'goal', 'subgoals', 'planner', 'sequence']);
          const title = typeof body.title === 'string' ? body.title : '未命名编队';
          const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
          if (!goal) throw new HttpError(400, 'crew_goal_required');
          const subgoals = Array.isArray(body.subgoals)
            ? body.subgoals.filter((item): item is string => typeof item === 'string' && !!item.trim()) : undefined;
          const catalog = await buildCrewCatalog(principal.tenantId);
          const plan = planCrew({
            title, goal, ...(subgoals ? { subgoals } : {}),
            planner: body.planner === 'main-agent' ? 'main-agent' : 'platform',
            sequence: body.sequence === 'sequential' ? 'sequential' : 'parallel',
            catalog, bindings: modelBindings().list(principal.tenantId)
          });
          crewPlans().save(plan);
          liveEvents.publish('crew', 'plan');
          sendJson(res, 201, { plan, catalogCount: catalog.models.length });
          return;
        }
        const crewDispatch = /^\/api\/crew\/([a-f0-9-]{36})\/dispatch$/.exec(url.pathname);
        if (crewDispatch && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const plan = crewPlans().get(crewDispatch[1]);
          if (!plan) throw new HttpError(404, 'crew_plan_not_found');
          const catalog = await buildCrewCatalog(principal.tenantId);
          const tasks: Record<string, unknown>[] = [];
          const receipt: CrewDispatchRecord[] = [];
          const skipped: { assignmentId: string; reason: string }[] = [];
          const at = new Date().toISOString();
          for (const assignment of plan.assignments) {
            if (!assignment.ready) { skipped.push({ assignmentId: assignment.id, reason: 'needs_provider_model' }); continue; }
            try {
              const created = routes.create({ title: plan.title + ' · ' + assignment.title, goal: assignment.description, mode: assignment.mode, limitMinor: 200 });
              let bound = false;
              try {
                modelBindings().bind({ tenantId: principal.tenantId, agent: assignment.agent, modelId: assignment.modelId, scope: { kind: 'task', taskId: created.taskId } }, catalog);
                bound = true;
              } catch { bound = false; }
              tasks.push({ assignmentId: assignment.id, taskId: created.taskId, agent: assignment.agent, modelId: assignment.modelId, mode: assignment.mode, bound });
              receipt.push({
                assignmentId: assignment.id, taskId: created.taskId, agent: assignment.agent,
                modelId: assignment.modelId, mode: assignment.mode, bound, at
              });
            } catch (error) {
              skipped.push({ assignmentId: assignment.id, reason: error instanceof Error ? error.message : 'dispatch_failed' });
            }
          }
          // Persist the parent → child receipts before answering, so the crew page can
          // rebuild the task tree from storage instead of React state.
          crewPlans().recordDispatch(plan.planId, receipt, skipped.map((entry) => ({ ...entry, at })));
          liveEvents.publish('crew', 'dispatch');
          if (tasks.length) liveEvents.publish('tasks', 'crew-dispatch');
          liveEvents.publish('agents', 'crew-dispatch');
          sendJson(res, 202, { planId: plan.planId, tasks, skipped });
          return;
        }
        if (url.pathname === '/api/pipeline/simulate' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(32768);
          allowOnly(body, ['title', 'goal', 'subgoals', 'maxReworks', 'budgetMinor', 'mode', 'notify']);
          const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
          if (!goal) throw new HttpError(400, 'pipeline_goal_required');
          const subgoals = Array.isArray(body.subgoals)
            ? body.subgoals.filter((item): item is string => typeof item === 'string' && !!item.trim()) : undefined;
          const catalog = await buildCrewCatalog(principal.tenantId);
          const mode = body.mode === 'pass' || body.mode === 'blocked' || body.mode === 'budget' ? body.mode : 'rework';
          const view = await simulatePipeline({
            title: typeof body.title === 'string' ? body.title : '未命名执行链',
            goal, ...(subgoals ? { subgoals } : {}),
            catalog, bindings: modelBindings().list(principal.tenantId),
            ...(typeof body.maxReworks === 'number' ? { maxReworks: body.maxReworks } : {}),
            ...(typeof body.budgetMinor === 'number' ? { budgetMinor: body.budgetMinor } : {}),
            mode
          });
          if (body.notify === true) {
            const map: Record<string, 'task.completed' | 'task.blocked' | 'task.review'> = {
              'pipeline.passed': 'task.completed', 'pipeline.blocked': 'task.blocked',
              'pipeline.budget_exhausted': 'task.blocked', 'pipeline.reviewer_reject_2': 'task.review'
            };
            for (const note of view.notifications) {
              const event = map[note.event];
              if (event) await notifications().notify(event, note.text);
            }
          }
          liveEvents.publish('crew', 'pipeline');
          sendJson(res, 200, view);
          return;
        }
        // ── 执行链留存运行：规划→执行→协作群回传→任意阶段换 Agent/模型重跑 ──
        if (url.pathname === '/api/pipeline/run' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(32768);
          allowOnly(body, ['title', 'goal', 'subgoals', 'maxReworks', 'budgetMinor', 'costPerAttemptMinor', 'mode', 'runtime', 'notify']);
          const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
          if (!goal) throw new HttpError(400, 'pipeline_goal_required');
          const subgoals = Array.isArray(body.subgoals)
            ? body.subgoals.filter((item): item is string => typeof item === 'string' && !!item.trim()) : undefined;
          const catalog = await buildCrewCatalog(principal.tenantId);
          const mode = body.mode === 'pass' || body.mode === 'blocked' || body.mode === 'budget' ? body.mode : 'rework';
          const runtime = body.runtime === 'real' ? pipelineRealRuntime(goal) : undefined;
          let record = await createAndRunPipeline({
            title: typeof body.title === 'string' ? body.title : '未命名执行链',
            goal, ...(subgoals ? { subgoals } : {}),
            catalog, bindings: modelBindings().list(principal.tenantId),
            ...(typeof body.maxReworks === 'number' ? { maxReworks: body.maxReworks } : {}),
            ...(typeof body.budgetMinor === 'number' ? { budgetMinor: body.budgetMinor } : {}),
            ...(typeof body.costPerAttemptMinor === 'number' ? { costPerAttemptMinor: body.costPerAttemptMinor } : {}),
            ...(runtime ? { runtime } : {}),
            mode
          });
          const synced = await syncPipelineRoom(agentRooms(), record, runtime?.discussion);
          record = attachRoomDiscussions(record, synced.roomId, synced.discussions);
          pipelineRuns().save(record);
          if (body.notify === true) {
            const map: Record<string, 'task.completed' | 'task.blocked' | 'task.review'> = {
              'pipeline.passed': 'task.completed', 'pipeline.blocked': 'task.blocked',
              'pipeline.budget_exhausted': 'task.blocked', 'pipeline.reviewer_reject_2': 'task.review'
            };
            for (const note of record.view.notifications) {
              const event = map[note.event];
              if (event) await notifications().notify(event, note.text);
            }
          }
          liveEvents.publish('crew', 'pipeline');
          liveEvents.publish('agents', 'pipeline-room');
          sendJson(res, 201, { runId: record.runId, roomId: record.roomId, view: record.view });
          return;
        }
        if (url.pathname === '/api/pipeline/runs' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { runs: pipelineRuns().list().map((record) => ({
            runId: record.runId, title: record.plan.title, stage: record.view.stage,
            steps: record.view.steps.length, roomId: record.roomId, updatedAt: record.updatedAt
          })) });
          return;
        }
        const pipelineRunOne = /^\/api\/pipeline\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (pipelineRunOne && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const record = pipelineRuns().get(pipelineRunOne[1]!);
          if (!record) throw new HttpError(404, 'pipeline_run_not_found');
          sendJson(res, 200, { runId: record.runId, plan: record.plan, view: record.view, roomId: record.roomId });
          return;
        }
        const pipelineReassign = /^\/api\/pipeline\/runs\/([a-f0-9-]{36})\/reassign$/.exec(url.pathname);
        if (pipelineReassign && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['stepId', 'agent', 'providerId', 'modelId']);
          const stepId = typeof body.stepId === 'string' ? body.stepId : '';
          const agent = typeof body.agent === 'string' ? body.agent : '';
          if (!stepId || !agent) throw new HttpError(400, 'pipeline_reassign_input_invalid');
          let record = pipelineRuns().get(pipelineReassign[1]!);
          if (!record) throw new HttpError(404, 'pipeline_run_not_found');
          const runtime = record.executorKind === 'real' ? pipelineRealRuntime(record.plan.goal) : undefined;
          record = await reassignAndRerun(record, stepId, {
            agent: agent as PipelineAgent,
            ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
            ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {})
          }, runtime);
          const synced = await syncPipelineRoom(agentRooms(), record, runtime?.discussion);
          record = attachRoomDiscussions(record, synced.roomId, synced.discussions);
          pipelineRuns().save(record);
          liveEvents.publish('crew', 'pipeline');
          liveEvents.publish('agents', 'pipeline-room');
          sendJson(res, 200, { runId: record.runId, roomId: record.roomId, view: record.view });
          return;
        }
        const pipelineRerun = /^\/api\/pipeline\/runs\/([a-f0-9-]{36})\/rerun$/.exec(url.pathname);
        if (pipelineRerun && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['stepId']);
          const stepId = typeof body.stepId === 'string' ? body.stepId : '';
          if (!stepId) throw new HttpError(400, 'pipeline_step_required');
          let record = pipelineRuns().get(pipelineRerun[1]!);
          if (!record) throw new HttpError(404, 'pipeline_run_not_found');
          const runtime = record.executorKind === 'real' ? pipelineRealRuntime(record.plan.goal) : undefined;
          record = await rerunPipelineStage(record, stepId, runtime);
          const synced = await syncPipelineRoom(agentRooms(), record, runtime?.discussion);
          record = attachRoomDiscussions(record, synced.roomId, synced.discussions);
          pipelineRuns().save(record);
          liveEvents.publish('crew', 'pipeline');
          liveEvents.publish('agents', 'pipeline-room');
          sendJson(res, 200, { runId: record.runId, roomId: record.roomId, view: record.view });
          return;
        }
        if (url.pathname === '/api/magpie/inventory' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, scanMagpieInventory());
          return;
        }
        if (url.pathname === '/api/magpie/local-quotas' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const quotaFile = join(process.env.USERPROFILE ?? '', '.config', 'magpie', 'quotas.json');
          let quotaCards: unknown[] = [];
          if (existsSync(quotaFile)) {
            try {
              const raw = JSON.parse(readFileSync(quotaFile, 'utf8')) as Record<string, { at?: string; quota?: { provider?: string; name?: string; plan?: string; user?: string; windows?: { name?: string; used?: number; resetsAt?: string; display?: string }[] } }>;
              quotaCards = Object.values(raw).map((entry) => {
                const quota = entry.quota ?? {};
                return {
                  provider: quota.provider ?? 'unknown',
                  name: quota.name || quota.provider || '账号',
                  plan: quota.plan ?? '',
                  user: quota.user ?? '',
                  checkedAt: entry.at ?? '',
                  windows: (quota.windows ?? []).map((span) => ({
                    name: span.name ?? '额度',
                    used: typeof span.used === 'number' ? span.used : 0,
                    remainingPercent: typeof span.used === 'number' ? Math.max(0, Math.min(100, 100 - span.used)) : 100,
                    ...(span.resetsAt ? { resetsAt: span.resetsAt } : {}),
                    ...(span.display ? { display: span.display } : {})
                  }))
                };
              });
            } catch { quotaCards = []; }
          }
          sendJson(res, 200, { cards: quotaCards });
          return;
        }
        if (url.pathname === '/api/notifications' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, notifications().list());
          return;
        }
        if (url.pathname === '/api/notifications/channels' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['id', 'enabled', 'endpoint', 'secret', 'events']);
          const id = body.id;
          if (typeof id !== 'string' || !(id in { feishu: 1, wecom: 1, wechat: 1, qq: 1, webhook: 1 })) {
            throw new HttpError(400, 'notification_channel_invalid');
          }
          try { sendJson(res, 200, notifications().save(id as NotificationChannelId, body)); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'notification_channel_invalid'); }
          liveEvents.publish('notifications', 'channel');
          return;
        }
        if (url.pathname === '/api/notifications/test' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(2048);
          allowOnly(body, ['id']);
          const id = body.id;
          if (typeof id !== 'string' || !(id in { feishu: 1, wecom: 1, wechat: 1, qq: 1, webhook: 1 })) {
            throw new HttpError(400, 'notification_channel_invalid');
          }
          try { await notifications().test(id as NotificationChannelId); sendJson(res, 200, { ok: true }); }
          catch (error) { throw new HttpError(502, error instanceof Error ? error.message : 'notification_test_failed'); }
          liveEvents.publish('notifications', 'test');
          return;
        }
        if (url.pathname === '/api/notifications/remote' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(4096);
          allowOnly(body, ['publicBaseUrl', 'regenerate']);
          if (body.regenerate === true) notifications().regenerateRemoteToken();
          sendJson(res, 200, notifications().setRemote(body.publicBaseUrl));
          liveEvents.publish('notifications', 'remote');
          return;
        }
        if (url.pathname === '/api/projects' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { projects: projectInputs().listProjects() });
          return;
        }
        if (url.pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const projectId = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
          if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) throw new HttpError(400, 'invalid_project_id');
          const deleted = projectInputs().deleteProject(projectId);
          liveEvents.publish('platform', 'projects-deleted');
          sendJson(res, deleted ? 200 : 404, { deleted, projectId });
          return;
        }
        if (url.pathname === '/api/masking/settings' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { settings: maskingStore().get() });
          return;
        }
        if (url.pathname === '/api/masking/settings' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['enabled', 'maskSecrets', 'maskPersonal', 'keepFormat', 'customWords', 'exemptProviders']);
          const settings = maskingStore().update(body as Record<string, unknown>);
          liveEvents.publish('gateway', 'masking-settings');
          sendJson(res, 200, { settings });
          return;
        }
        if (url.pathname === '/api/masking/preview' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const body = await readInput(32768);
          allowOnly(body, ['text']);
          const text = typeof body.text === 'string' ? body.text : '';
          sendJson(res, 200, maskOutboundText(text, maskingStore().get()));
          return;
        }
        if (url.pathname === '/api/portfolio/digest' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, portfolioDigestView(Date.now()));
          return;
        }
        if (url.pathname === '/api/portfolio/push' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const digest = portfolioDigestView(Date.now());
          const pushed = await portfolioNotify().run(digest);
          sendJson(res, 200, { pushed, anyChannelEnabled: portfolioPushEnabled(), digest });
          return;
        }
        if (url.pathname === '/api/portfolio/decide' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(4096);
          allowOnly(body, ['itemId', 'action', 'note']);
          if (typeof body.itemId !== 'string' || !body.itemId.trim()) throw new HttpError(400, 'portfolio_item_id_required');
          if (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'defer') throw new HttpError(400, 'portfolio_action_invalid');
          const digest = portfolioDigestView(Date.now());
          const item = [...digest.realtime, ...digest.digest].find((entry) => entry.itemId === body.itemId);
          if (!item) throw new HttpError(404, 'portfolio_item_not_found');
          try {
            const result = portfolioDecisions().decide({
              itemId: item.itemId, projectId: item.projectId, kind: item.kind, action: body.action,
              actorId: principal.userId, decidedAt: new Date().toISOString(),
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
            });
            sendJson(res, 200, { decision: result.record, duplicate: result.duplicate });
          } catch (error) {
            if (error instanceof PortfolioDecisionError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'portfolio_decide_failed');
          }
          liveEvents.publish('portfolio', 'decision');
          return;
        }
        if (url.pathname === '/api/portfolio/decisions' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { decisions: portfolioDecisions().list() });
          return;
        }
        if (url.pathname === '/api/platform/catalog' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { providers: platformProviders().list(), agents: platformAgents().list(), defaultModel: platformProviders().defaultModel() });
          return;
        }
        if (url.pathname === '/api/platform/providers' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['id', 'api', 'baseUrl', 'models', 'apiKeyEnv', 'headers', 'weight']);
          try {
            const added = platformProviders().add(body);
            liveEvents.publish('providers', 'provider');
            liveEvents.publish('platform', 'provider');
            liveEvents.publish('routing', 'provider');
            if (gatewayServeManagerInstance && gatewayServeManagerInstance.status().state === 'running') { void gatewayServeManagerInstance.reload().catch(() => undefined); }
            sendJson(res, 201, added);
          }
          catch (error) { if (error instanceof PlatformCatalogError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'provider_invalid'); }
          return;
        }
        if (url.pathname === '/api/platform/providers' && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const id = url.searchParams.get('id') ?? '';
          if (!platformProviders().remove(id)) throw new HttpError(404, 'provider_not_found');
          liveEvents.publish('providers', 'provider');
          liveEvents.publish('platform', 'provider');
          liveEvents.publish('routing', 'provider');
          sendJson(res, 200, { removed: id });
          return;
        }
        if (url.pathname === '/api/platform/agents' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['agentId', 'name', 'runtime', 'providerId', 'modelId', 'instructions']);
          try { sendJson(res, 201, platformAgents().add(body)); }
          catch (error) { if (error instanceof PlatformCatalogError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'agent_invalid'); }
          liveEvents.publish('agents', 'profile');
          liveEvents.publish('routing', 'agent-profile');
          return;
        }
        if (url.pathname === '/api/platform/agents' && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const id = url.searchParams.get('id') ?? '';
          if (!platformAgents().remove(id)) throw new HttpError(404, 'agent_not_found');
          liveEvents.publish('agents', 'profile');
          liveEvents.publish('routing', 'agent-profile');
          sendJson(res, 200, { removed: id });
          return;
        }
        if (url.pathname === '/api/platform/agents/model' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(4096);
          allowOnly(body, ['agentId', 'providerId', 'modelId']);
          try {
            sendJson(res, 200, platformAgents().setModel(String(body.agentId ?? ''), String(body.providerId ?? ''), String(body.modelId ?? '')));
          } catch (error) { if (error instanceof PlatformCatalogError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'agent_model_switch_failed'); }
          liveEvents.publish('agents', 'model');
          liveEvents.publish('routing', 'agent-profile');
          return;
        }
        if (url.pathname === '/api/platform/groups' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { groups: routingGroups().list() });
          return;
        }
        if (url.pathname === '/api/platform/groups' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['groupId', 'name', 'members', 'strategy']);
          try { sendJson(res, 201, routingGroups().add(body)); }
          catch (error) { if (error instanceof RoutingError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'group_invalid'); }
          liveEvents.publish('routing', 'group');
          return;
        }
        if (url.pathname === '/api/platform/groups' && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const id = url.searchParams.get('id') ?? '';
          if (!routingGroups().remove(id)) throw new HttpError(404, 'group_not_found');
          liveEvents.publish('routing', 'group');
          sendJson(res, 200, { removed: id });
          return;
        }
        if (url.pathname === '/api/platform/profiles' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { profiles: routingProfiles().list() });
          return;
        }
        if (url.pathname === '/api/platform/profiles' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(16384);
          allowOnly(body, ['profileId', 'name', 'assignments']);
          try { sendJson(res, 201, routingProfiles().add(body)); }
          catch (error) { if (error instanceof RoutingError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'profile_invalid'); }
          liveEvents.publish('routing', 'profile');
          return;
        }
        if (url.pathname === '/api/platform/profiles' && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const id = url.searchParams.get('id') ?? '';
          if (!routingProfiles().remove(id)) throw new HttpError(404, 'profile_not_found');
          liveEvents.publish('routing', 'profile');
          sendJson(res, 200, { removed: id });
          return;
        }
        if (url.pathname === '/api/platform/profiles/apply' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(4096);
          allowOnly(body, ['profileId']);
          const profile = routingProfiles().get(String(body.profileId ?? ''));
          if (!profile) throw new HttpError(404, 'profile_not_found');
          const result = applyProfile(profile, platformAgents());
          liveEvents.publish('routing', 'profile-apply');
          liveEvents.publish('agents', 'profile-apply');
          sendJson(res, 200, result);
          return;
        }
        if (url.pathname === '/api/platform/mask/preview' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const body = await readInput(65536);
          allowOnly(body, ['text']);
          if (typeof body.text !== 'string') throw new HttpError(400, 'text_required');
          const result = maskText(body.text);
          sendJson(res, 200, { masked: result.masked, findings: result.findings, count: result.findings.length });
          return;
        }
        if (url.pathname === '/api/gateway/observability' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const limit = Number(url.searchParams.get('limit') ?? '60');
          sendJson(res, 200, gatewayRequests().view(Number.isFinite(limit) ? limit : 60));
          return;
        }
        if (url.pathname === '/api/gateway/requests' && req.method === 'POST') {          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(262144);
          allowOnly(body, ['requestId', 'at', 'agent', 'providerId', 'modelId', 'status', 'latencyMs', 'firstTokenMs',
            'outputTokenPerSec', 'inputTokens', 'outputTokens', 'cacheHitPercent', 'costMinor', 'maskedCount', 'error',
            'contextLimitTokens', 'contextParts', 'taskId']);
          try { sendJson(res, 201, gatewayRequests().append(body)); }
          catch (error) { if (error instanceof GatewayObsError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'gateway_request_invalid'); }
          liveEvents.publish('gateway', 'request');
          return;
        }
        if (url.pathname === '/api/gateway/requests' && req.method === 'DELETE') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          gatewayRequests().clear();
          liveEvents.publish('gateway', 'clear');
          sendJson(res, 200, { cleared: true });
          return;
        }
        if (url.pathname === '/api/gateway/context' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const record = gatewayRequests().get(url.searchParams.get('requestId') ?? '');
          if (!record) throw new HttpError(404, 'request_not_found');
          sendJson(res, 200, contextComposition(record));
          return;
        }
        if (url.pathname === '/api/platform/gateway/status' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, gatewayServeManager().status());
          return;
        }
        if (url.pathname === '/api/platform/gateway/start' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          try { sendJson(res, 200, await gatewayServeManager().start()); }
          catch { sendJson(res, 502, gatewayServeManager().status()); }
          liveEvents.publish('platform', 'gateway');
          return;
        }
        if (url.pathname === '/api/platform/gateway/stop' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          sendJson(res, 200, await gatewayServeManager().stop());
          liveEvents.publish('platform', 'gateway');
          return;
        }
        if (url.pathname === '/api/platform/gateway/reload' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          try { sendJson(res, 200, await gatewayServeManager().reload()); }
          catch { sendJson(res, 502, gatewayServeManager().status()); }
          liveEvents.publish('platform', 'gateway');
          liveEvents.publish('providers', 'gateway-reload');
          return;
        }
        if (url.pathname === '/api/portfolio/autonomy' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole !== 'owner') throw new HttpError(403, 'tenant_owner_required');
          const body = await readInput(4096);
          allowOnly(body, ['projectId', 'mode', 'autoAccept', 'maxInterruptsPerDay']);
          if (typeof body.projectId !== 'string' || !body.projectId.trim()) throw new HttpError(400, 'project_id_required');
          const mode = body.mode;
          if (mode !== 'auto' && mode !== 'managed' && mode !== 'supervised') throw new HttpError(400, 'autonomy_mode_invalid');
          const base = portfolioProfiles().getProfile(body.projectId);
          const profile: AutonomyProfileView = {
            ...base, mode,
            autoAccept: mode === 'auto' ? body.autoAccept !== false : false,
            ...(typeof body.maxInterruptsPerDay === 'number' && Number.isSafeInteger(body.maxInterruptsPerDay) && body.maxInterruptsPerDay >= 0
              ? { maxInterruptsPerDay: Math.min(50, body.maxInterruptsPerDay) } : {})
          };
          portfolioProfiles().setProfile(profile);
          liveEvents.publish('portfolio', 'autonomy');
          sendJson(res, 200, profile);
          return;
        }
        if (url.pathname === '/api/projects/intake-upload' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(262144);
          allowOnly(body, ['projectId', 'specText', 'planBaselineText']);
          if (typeof body.specText !== 'string' || typeof body.planBaselineText !== 'string') {
            throw new HttpError(400, 'project_upload_text_required');
          }
          const projectId = typeof body.projectId === 'string' && body.projectId.trim()
            ? body.projectId.trim() : projectIdFromDirectory('upload-' + randomBytes(4).toString('hex'));
          const directory = join(lock.base, 'projects', projectId);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'spec.md'), body.specText, 'utf8');
          writeFileSync(join(directory, 'plan_baseline.md'), body.planBaselineText, 'utf8');
          const spec = parseSpecDocument(body.specText);
          const planBaseline = parsePlanDocument(body.planBaselineText);
          try {
            const frozen = projectInputs().submitProject({ ownerId: principal.userId, spec, planBaseline, projectId });
            projectInputs().registerDirectory(frozen.projectId, directory, principal.userId);
            sendJson(res, 201, {
              projectId: frozen.projectId, revision: frozen.revision, status: frozen.status,
              directoryPath: directory, specCount: spec.length, planCount: planBaseline.length
            });
          } catch (error) {
            if (error instanceof ProjectInputError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_intake_invalid');
          }
          return;
        }
        if (url.pathname === '/api/projects/intake' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(16384);
          allowOnly(body, ['mode', 'directoryPath', 'projectId']);
          const mode = body.mode;
          if (mode !== 'open' && mode !== 'create') throw new HttpError(400, 'project_mode_invalid');
          if (typeof body.directoryPath !== 'string' || !body.directoryPath.trim() ||
              !(isAbsolute(body.directoryPath) || /^[a-zA-Z]:[\\/]/.test(body.directoryPath))) {
            throw new HttpError(400, 'absolute_project_path_required');
          }
          const directory = resolve(body.directoryPath);
          if (mode === 'create') {
            if (existsSync(directory) && !statSync(directory).isDirectory()) throw new HttpError(409, 'project_path_not_directory');
            mkdirSync(directory, { recursive: true });
            sendJson(res, 201, { needsFiles: true, directoryPath: directory });
            return;
          }
          if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new HttpError(404, 'project_directory_missing');
          const specPath = [join(directory, 'spec.md'), join(directory, 'spec.json')].find((candidate) => existsSync(candidate));
          const baselinePath = [join(directory, 'plan_baseline.md'), join(directory, 'plan_baseline.json')].find((candidate) => existsSync(candidate));
          if (!specPath || !baselinePath) throw new HttpError(409, 'project_requires_spec_and_plan_baseline');
          const spec = parseSpecDocument(readFileSync(specPath, 'utf8'));
          const planBaseline = parsePlanDocument(readFileSync(baselinePath, 'utf8'));
          const projectId = typeof body.projectId === 'string' && body.projectId.trim()
            ? body.projectId.trim() : projectIdFromDirectory(basename(directory));
          try {
            const frozen = projectInputs().submitProject({
              ownerId: principal.userId, spec, planBaseline, projectId
            });
            projectInputs().registerDirectory(frozen.projectId, directory, principal.userId);
            sendJson(res, 201, {
              projectId: frozen.projectId, revision: frozen.revision, status: frozen.status,
              directoryPath: directory, specCount: spec.length, planCount: planBaseline.length
            });
          } catch (error) {
            if (error instanceof ProjectInputError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_intake_invalid');
          }
          return;
        }
        if (url.pathname === '/api/project-input' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(65536);
          allowOnly(body, ['spec', 'planBaseline', 'planRuntime', 'naturalLanguage', 'projectId']);
          try {
            const frozen = projectInputs().submitProject({
              ownerId: principal.userId,
              spec: body.spec as never,
              planBaseline: body.planBaseline as never,
              ...(body.planRuntime !== undefined ? { planRuntime: body.planRuntime as never } : {}),
              ...(body.naturalLanguage !== undefined ? { naturalLanguage: body.naturalLanguage as string } : {}),
              ...(body.projectId !== undefined ? { projectId: body.projectId as string } : {})
            });
            sendJson(res, 201, { frozen });
          } catch (error) {
            if (error instanceof ProjectInputError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_input_invalid');
          }
          return;
        }
        if (url.pathname === '/api/project-input/latest' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          const projectId = url.searchParams.get('projectId') ?? '';
          const frozen = projectInputs().latest(projectId);
          if (!frozen) throw new HttpError(404, 'project_input_missing');
          sendJson(res, 200, { frozen, progress: projectInputs().getProgress(projectId) ?? null });
          return;
        }
        // ---- 项目工作台（第一版骨架：Spec/Plan → 串行阶段 + Progress.md + 功能清单 JSON） ----
        if (url.pathname === '/api/workbench/projects' && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          sendJson(res, 200, { projects: workbench().list() });
          return;
        }
        if (url.pathname === '/api/workbench/projects' && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const body = await readInput(262144);
          allowOnly(body, ['projectId', 'title', 'specText', 'planBaselineText']);
          if (typeof body.specText !== 'string' || typeof body.planBaselineText !== 'string') {
            throw new HttpError(400, 'project_upload_text_required');
          }
          const projectId = typeof body.projectId === 'string' && body.projectId.trim()
            ? body.projectId.trim() : projectIdFromDirectory('project-' + randomBytes(4).toString('hex'));
          const directory = join(lock.base, 'projects', projectId);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'spec.md'), body.specText, 'utf8');
          writeFileSync(join(directory, 'plan_baseline.md'), body.planBaselineText, 'utf8');
          const spec = parseSpecDocument(body.specText);
          const planBaseline = parsePlanDocument(body.planBaselineText);
          try {
            const frozen = projectInputs().submitProject({ ownerId: principal.userId, spec, planBaseline, projectId });
            projectInputs().registerDirectory(frozen.projectId, directory, principal.userId);
            const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
            const view = workbench().ensure(frozen.projectId, { ...workbenchSeed(frozen.projectId), ...(title ? { title } : {}) });
            sendJson(res, 201, { view });
          } catch (error) {
            if (error instanceof ProjectInputError) throw new HttpError(error.status, error.message);
            if (error instanceof ProjectWorkbenchError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_workbench_invalid');
          }
          return;
        }
        const wbOne = /^\/api\/workbench\/projects\/([a-z0-9][a-z0-9._-]{2,63})$/.exec(url.pathname);
        if (wbOne && req.method === 'GET') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          try {
            sendJson(res, 200, { view: workbench().view(wbOne[1], workbenchSeed(wbOne[1])) });
          } catch (error) {
            if (error instanceof ProjectWorkbenchError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_workbench_invalid');
          }
          return;
        }
        const wbAction = /^\/api\/workbench\/projects\/([a-z0-9][a-z0-9._-]{2,63})\/(expand|advance|progress)$/.exec(url.pathname);
        if (wbAction && req.method === 'POST') {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const projectId = wbAction[1];
          const action = wbAction[2];
          try {
            if (action === 'progress') {
              const body = await readInput(131072);
              allowOnly(body, ['text']);
              if (typeof body.text !== 'string') throw new HttpError(400, 'progress_text_required');
              sendJson(res, 200, { view: workbench().setProgress(projectId, body.text) });
            } else if (action === 'expand') {
              sendJson(res, 200, { view: workbench().expand(projectId, workbenchSeed(projectId)) });
            } else {
              sendJson(res, 200, { view: workbench().advance(projectId, workbenchSeed(projectId)) });
            }
          } catch (error) {
            if (error instanceof ProjectWorkbenchError) throw new HttpError(error.status, error.message);
            throw new HttpError(400, 'project_workbench_invalid');
          }
          return;
        }
        // ---- 平台级 Git 身份（一次验证，全平台项目复用）----
        if (/^\/api\/git-account$/.test(url.pathname)) {
          if (!initialized || !principal) throw new HttpError(401, 'persistent_identity_required');
          if (req.method === 'GET') {
            sendJson(res, 200, { accounts: gitAccounts().list() });
            return;
          }
          if (principal.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          if (req.method === 'POST') {
            const body = await readInput(16384);
            allowOnly(body, ['provider', 'token']);
            const provider = normalizeProvider(body.provider);
            if (!provider) throw new HttpError(400, 'invalid_provider');
            const token = typeof body.token === 'string' ? body.token : '';
            try {
              const account = await gitAccounts().save(provider, token);
              sendJson(res, 200, { account });
            } catch (error) {
              const code = error instanceof Error ? error.message : 'save_failed';
              throw new HttpError(code === 'invalid_token_format' || code === 'empty_token' || code === 'token_rejected' ? 400 : 502, code);
            }
            return;
          }
          if (req.method === 'DELETE') {
            const provider = normalizeProvider(url.searchParams.get('provider'));
            if (!provider) throw new HttpError(400, 'invalid_provider');
            gitAccounts().clear(provider);
            sendJson(res, 200, { ok: true });
            return;
          }
          throw new HttpError(405, 'method_not_allowed');
        }
        // ---- 项目工作台 · B 阶段：隔离副本 / 验证门 / Git 提交与推送 ----
        const wbGitAction = /^\/api\/workbench\/projects\/([a-z0-9][a-z0-9._-]{2,63})\/(workspace|verify|commit|push|remote|create-repo)$/.exec(url.pathname);
        const wbGitStatus = /^\/api\/workbench\/projects\/([a-z0-9][a-z0-9._-]{2,63})\/git$/.exec(url.pathname);
        if ((wbGitAction || wbGitStatus) && (!initialized || !principal)) throw new HttpError(401, 'persistent_identity_required');
        if (wbGitStatus && req.method === 'GET') {
          try { sendJson(res, 200, { status: await projectGit().gitStatus(wbGitStatus[1]) }); }
          catch (error) { if (error instanceof ProjectGitError) throw new HttpError(error.status, error.message); throw new HttpError(400, 'project_git_invalid'); }
          return;
        }
        if (wbGitAction && req.method === 'POST') {
          if (principal?.memberRole === 'viewer') throw new HttpError(403, 'tenant_operator_required');
          const projectId = wbGitAction[1];
          const action = wbGitAction[2];
          try {
            if (action === 'remote') {
              const body = await readInput(16384);
              allowOnly(body, ['repoUrl']);
              const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';
              sendJson(res, 200, { remote: await projectGit().setRemoteUrl(projectId, repoUrl) });
            } else if (action === 'workspace') {
              const body = await readInput(131072);
              allowOnly(body, ['sourceDir']);
              let sourceDir = typeof body.sourceDir === 'string' ? body.sourceDir : undefined;
              if (!sourceDir) {
                const known = projectInputs().listProjects().find((row) => row.projectId === projectId);
                if (known?.directory) sourceDir = known.directory;
              }
              sendJson(res, 200, { workspace: projectGit().setWorkDir(projectId, sourceDir) });
            } else if (action === 'verify') {
              const body = await readInput(16384);
              allowOnly(body, ['timeoutMs']);
              const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 900000) : undefined;
              sendJson(res, 200, { verify: await projectGit().verify(projectId, timeoutMs) });
            } else if (action === 'commit') {
              const body = await readInput(16384);
              allowOnly(body, ['message']);
              const message = typeof body.message === 'string' ? body.message : undefined;
              sendJson(res, 200, { commit: await projectGit().commit(projectId, message) });
            } else if (action === 'create-repo') {
              const body = await readInput(16384);
              allowOnly(body, ['provider', 'name', 'private', 'description']);
              const provider = normalizeProvider(body.provider);
              if (!provider) throw new HttpError(400, 'invalid_provider');
              const name = typeof body.name === 'string' ? body.name.trim() : '';
              const isPrivate = body.private !== false;
              const description = typeof body.description === 'string' ? body.description : undefined;
              let repo;
              try {
                repo = await gitAccounts().createRepo(provider, { name, private: isPrivate, description });
              } catch (error) {
                const code = error instanceof Error ? error.message : 'create_failed';
                throw new HttpError(code === 'no_token' || code === 'invalid_repo_name' || code === 'repo_exists' || code === 'token_no_create_permission' ? 400 : 502, code);
              }
              const remote = await projectGit().setRemoteUrl(projectId, repo.cloneUrl);
              sendJson(res, 200, { repo, remote });
            } else {
              const body = await readInput(16384);
              allowOnly(body, ['repoName', 'visibility', 'repoUrl', 'token']);
              const repoName = typeof body.repoName === 'string' ? body.repoName : undefined;
              const visibility = body.visibility === 'public' ? 'public' : 'private';
              const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : undefined;
              const token = typeof body.token === 'string' && body.token.length > 0 && body.token.length <= 4096 ? body.token : undefined;
              sendJson(res, 200, { push: await projectGit().push(projectId, { repoName, visibility, repoUrl, token }) });
            }
          } catch (error) {
            if (error instanceof ProjectGitError) throw new HttpError(error.status, error.message);
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, 'project_git_invalid');
          }
          return;
        }
        const routeMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/route-authorization$/.exec(url.pathname);
        if (routeMatch && req.method === 'POST') {
          const input = await readJsonBody(req) as CreateMissionRouteAuthorizationInput;
          let catalog: MagpieRoutingCatalog;
          try { catalog = await magpie.routingCatalog?.() ?? (() => { throw new Error('unavailable'); })(); } catch { throw new HttpError(503, 'route_catalog_unavailable'); }
          try {
            if (initialized && principal) {
              if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
              catalog = identityStore().filterCatalog(principal, catalog);
            }
            sendJson(res, 201, missionControl.authorizeRoute(routeMatch[1], input, catalog));
            liveEvents.publish('missions');
          } catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        if (routeMatch && req.method === 'DELETE') {
          try { sendJson(res, 200, missionControl.revokeRoute(routeMatch[1])); liveEvents.publish('missions'); }
          catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const routePreflightMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/route-preflight$/.exec(url.pathname);
        if (routePreflightMatch && req.method === 'GET') {
          let catalog: MagpieRoutingCatalog | null = null;
          try { catalog = await magpie.routingCatalog?.() ?? null; } catch { /* unavailable means deny */ }
          try { sendJson(res, 200, missionControl.preflightRoute(routePreflightMatch[1],
            catalog && initialized && principal ? identityStore().filterCatalog(principal, catalog) : catalog)); }
          catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const routeAttemptsMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/route-attempts$/.exec(url.pathname);
        if (routeAttemptsMatch && req.method === 'POST') {
          const input = await readJsonBody(req) as PrepareMissionRouteAttemptInput;
          let catalog: MagpieRoutingCatalog | null = null;
          try { catalog = await magpie.routingCatalog?.() ?? null; } catch { /* refuse */ }
          if (!catalog) throw new HttpError(503, 'route_catalog_unavailable');
          try {
            sendJson(res, 201, missionControl.prepareRouteAttempt(routeAttemptsMatch[1], input,
              initialized && principal ? identityStore().filterCatalog(principal, catalog) : catalog));
            liveEvents.publish('missions');
          } catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const routeAttemptCancelMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/route-attempts\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (routeAttemptCancelMatch && req.method === 'DELETE') {
          try {
            sendJson(res, 200, missionControl.cancelRouteAttempt(routeAttemptCancelMatch[1], routeAttemptCancelMatch[2]));
            liveEvents.publish('missions');
          } catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const scopeProbeMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/route-scope-probe$/.exec(url.pathname);
        if (scopeProbeMatch && req.method === 'POST') {
          const input = await readJsonBody(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) ||
              Object.keys(input).length !== 0) throw new HttpError(400, 'invalid_scope_probe_body');
          const missionId = scopeProbeMatch[1];
          if (!magpie.probePinnedScope) throw new HttpError(503, 'pinned_scope_probe_unavailable');
          let catalog: MagpieRoutingCatalog | null = null;
          try { catalog = await magpie.routingCatalog?.() ?? null; } catch { /* deny */ }
          let binding;
          try {
            const preflight = missionControl.preflightRoute(missionId,
              catalog && initialized && principal ? identityStore().filterCatalog(principal, catalog) : catalog);
            if (!preflight.accountBindingValid) throw new HttpError(409, preflight.reason);
            binding = missionControl.routeBinding(missionId);
          } catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          if (!binding) throw new HttpError(409, 'route_binding_unavailable');
          if (!await magpie.scopeCapability?.()) throw new HttpError(503, 'magpie_task_scope_binary_upgrade_required');
          if (missionControl.scopeProbeStarted(missionId)) throw new HttpError(409, 'route_scope_probe_already_started');
          if (scopeConsentInFlight.has(missionId)) throw new HttpError(409, 'route_scope_probe_in_progress');
          scopeConsentInFlight.add(missionId);
          try {
            // Credential issuance is a real Magpie write, even though it never
            // sends a model request. A native Windows consent is mandatory.
            let permitted = false;
            try {
              permitted = await nativeApproval({
                operationId: randomBytes(16).toString('hex'),
                action: 'Magpie 临时账号范围验证（仅创建/撤销短期密钥，不调用模型）',
                target: binding.providerId + '/' + binding.modelId,
                expectedSid: currentWindowsSid()
              });
            } catch { permitted = false; }
            const stillActive = getRequestSession(req.headers.cookie);
            if (!permitted || !stillActive || stillActive.id !== session.id) {
              throw new HttpError(403, 'route_scope_native_confirmation_required');
            }
            // No account or mission mutation may sneak in while the native
            // consent window is open. Revalidate before the first side effect.
            let refreshed: MagpieRoutingCatalog | null = null;
            try { refreshed = await magpie.routingCatalog?.() ?? null; } catch { /* fail closed */ }
            const finalPreflight = missionControl.preflightRoute(missionId,
              refreshed && initialized && principal ? identityStore().filterCatalog(principal, refreshed) : refreshed);
            const currentBinding = missionControl.routeBinding(missionId);
            if (!finalPreflight.accountBindingValid || !currentBinding ||
                currentBinding.instanceId !== binding.instanceId ||
                currentBinding.providerId !== binding.providerId ||
                currentBinding.modelId !== binding.modelId ||
                currentBinding.accountRef !== binding.accountRef) {
              throw new HttpError(409, 'route_binding_changed_during_consent');
            }
            try { missionControl.beginScopeProbe(missionId); }
            catch (error) {
              if (error instanceof MissionError) throw new HttpError(error.status, error.message);
              throw error;
            }
            let probe;
            try { probe = await magpie.probePinnedScope(binding); }
            catch {
              // May have issued a key before the wire failed. Block reuse;
              // rely on the 1m TTL and require manual inspection, not retry.
              probe = { verified: false, keyRevoked: false, reason: 'scope_probe_effect_unknown' };
            }
            missionControl.recordScopeProbe(missionId, probe.verified);
            sendJson(res, 200, { missionId, ...probe, dispatchPermitted: false as const });
          } finally {
            scopeConsentInFlight.delete(missionId);
          }
          return;
        }
        if (url.pathname === '/api/command/missions' && req.method === 'POST') {
          const input = await readJsonBody(req);
          try {
            const mission = missionControl.create(input as CreateMissionInput);
            if (initialized && principal) identityStore().bindMission(principal, mission.missionId);
            if (mission.status === 'pending_event') {
              const routed = await autoloop.emit({
                id: 'daming-mission-' + mission.missionId, type: 'mission.requested',
                subject: mission.missionId, summary: '新的大铭离线协作任务需要人工决策'
              });
              const card = autoloop.state().cards.find((item) => item.kind === 'ask' &&
                item.title === '大铭任务审批 ' + mission.missionId);
              if (routed.routed.length && card) missionControl.attachCard(mission.missionId, card.id);
              else missionControl.failDispatch(mission.missionId);
              liveEvents.publish('autoloop');
            }
            sendJson(res, 201, missionControl.detail(mission.missionId));
          } catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const missionNotificationMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/notification-preview$/.exec(url.pathname);
        if (missionNotificationMatch && req.method === 'GET') {
          try { sendJson(res, 200, previewMissionNotification(missionControl.detail(missionNotificationMatch[1]))); }
          catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const missionDetailMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (missionDetailMatch && req.method === 'GET') {
          try { sendJson(res, 200, missionControl.detail(missionDetailMatch[1])); }
          catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          return;
        }
        const missionDecisionMatch = /^\/api\/command\/missions\/([a-f0-9-]{36})\/decision$/.exec(url.pathname);
        if (missionDecisionMatch && req.method === 'POST') {
          const input = await readJsonBody(req);
          const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
          if (Object.keys(body).some((key) => key !== 'choice' && key !== 'cardId') ||
            (body.choice !== 0 && body.choice !== 1) || !Number.isSafeInteger(body.cardId)) {
            throw new HttpError(400, 'invalid_mission_decision');
          }
          const id = missionDecisionMatch[1];
          let mission;
          try { mission = missionControl.detail(id); }
          catch (error) {
            if (error instanceof MissionError) throw new HttpError(error.status, error.message);
            throw error;
          }
          if (mission.status !== 'awaiting_decision' || mission.cardId !== body.cardId) {
            throw new HttpError(409, 'mission_decision_stale');
          }
          const card = autoloop.state().cards.find((item) => item.id === mission.cardId &&
            item.kind === 'ask' && item.title === '大铭任务审批 ' + id);
          if (!card) throw new HttpError(409, 'mission_card_not_open');
          const answered = autoloop.answer(mission.cardId!, { choice: body.choice as number });
          if (!answered.changed) throw new HttpError(409, 'mission_decision_already_handled');
          await autoloop.tick(); // The Autoloop kernel resumes the same mission after the user's choice.
          liveEvents.publish('autoloop');
          sendJson(res, 200, missionControl.detail(id));
          return;
        }
        if (url.pathname === '/api/tasks' && req.method === 'GET') {
          sendJson(res, 200, { tasks: initialized && principal
            ? routes.list().filter(task => identityStore().ownsTask(principal, task.taskId))
            : routes.list() });
          return;
        }
        if (url.pathname === '/api/lulu/status' && req.method === 'GET') {
          sendJson(res, 200, await lulu.status());
          return;
        }
        if (url.pathname === '/api/deepseek/balance' && req.method === 'GET') {
          sendJson(res, 200, await deepseekBalance.query());
          return;
        }
        if (url.pathname === '/api/magpie/status' && req.method === 'GET') {
          sendJson(res, 200, await magpie.status());
          return;
        }
        const magpieReadMatch = /^\/api\/magpie\/read\/([a-z-]+)$/.exec(url.pathname);
        if (magpieReadMatch && req.method === 'GET') {
          try { sendJson(res, 200, await magpie.read(magpieReadMatch[1])); }
          catch (error) { throw magpieError(error); }
          return;
        }
        if (url.pathname === '/api/magpie/operations' && req.method === 'GET') {
          sendJson(res, 200, { operations: operations.list() });
          return;
        }
        const magpiePrepareMatch = /^\/api\/magpie\/operations\/prepare\/([a-z-]+)$/.exec(url.pathname);
        if (magpiePrepareMatch && req.method === 'POST') {
          if (!(await magpie.status()).configured) throw new HttpError(503, 'magpie_not_ready');
          const body = await readJsonBody(req);
          try { sendJson(res, 201, operations.prepare(session.id, magpiePrepareMatch[1], body, currentWindowsSid())); liveEvents.publish('magpie'); }
          catch (error) {
            if (error instanceof MagpieOperationError) throw new HttpError(error.statusCode, error.message);
            throw magpieError(error);
          }
          return;
        }
        const magpieExecuteMatch = /^\/api\/magpie\/operations\/([a-f0-9-]{36})\/execute$/.exec(url.pathname);
        if (magpieExecuteMatch && req.method === 'POST') {
          const input = await readJsonBody(req);
          const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
          if (typeof body.approvalToken !== 'string' || Object.keys(body).length !== 1) throw new HttpError(400, 'invalid_magpie_approval');
          const operationId = magpieExecuteMatch[1];
          const actorSid = currentWindowsSid();
          let inspected;
          try { inspected = operations.inspectApproval(operationId, session.id, body.approvalToken, actorSid); }
          catch (error) {
            if (error instanceof MagpieOperationError) throw new HttpError(error.statusCode, error.message);
            throw error;
          }
          if (inspected.status !== 'prepared') {
            sendJson(res, inspected.status === 'executing' ? 202 : 200, inspected);
            return;
          }
          let windowsConfirmed = false;
          if (inspected.risk === 'high') {
            if (consentInFlight.has(operationId)) throw new HttpError(409, 'magpie_windows_confirmation_in_progress');
            consentInFlight.add(operationId);
            try {
              windowsConfirmed = await nativeApproval({
                operationId, action: inspected.action, target: inspected.target, expectedSid: actorSid
              });
            } catch {
              windowsConfirmed = false; // Native confirmation failures always deny.
            } finally {
              consentInFlight.delete(operationId);
            }
            const stillActive = getRequestSession(req.headers.cookie);
            if (!stillActive || stillActive.id !== session.id || !windowsConfirmed) {
              sendJson(res, 200, operations.cancelBeforeExecution(operationId, session.id, body.approvalToken, actorSid));
              liveEvents.publish('magpie');
              return;
            }
          }
          let started;
          try { started = operations.begin(operationId, session.id, body.approvalToken, actorSid, windowsConfirmed); }
          catch (error) {
            if (error instanceof MagpieOperationError) throw new HttpError(error.statusCode, error.message);
            throw error;
          }
          if (!started.execute) {
            sendJson(res, started.operation.status === 'executing' ? 202 : 200, started.operation);
            return;
          }
          try {
            const result = await magpie.post(started.action!, started.body!);
            sendJson(res, 200, operations.complete(magpieExecuteMatch[1], result));
            liveEvents.publish('magpie');
          } catch {
            // The remote endpoint may have applied an effect before the connection failed.
            // Persist unknown and never retry from here.
            sendJson(res, 202, operations.uncertain(magpieExecuteMatch[1]));
            liveEvents.publish('magpie');
          }
          return;
        }
        const magpieReconcileMatch = /^\/api\/magpie\/operations\/([a-f0-9-]{36})\/reconcile$/.exec(url.pathname);
        if (magpieReconcileMatch && req.method === 'POST') {
          const input = await readJsonBody(req);
          const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
          try { sendJson(res, 200, operations.reconcile(magpieReconcileMatch[1], body.resolution, body.evidence, session.id)); liveEvents.publish('magpie'); }
          catch (error) {
            if (error instanceof MagpieOperationError) throw new HttpError(error.statusCode, error.message);
            throw error;
          }
          return;
        }
        if (url.pathname === '/api/autoloop/state' && req.method === 'GET') {
          sendJson(res, 200, autoloop.state());
          return;
        }
        if (url.pathname === '/api/autoloop/events' && req.method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const field = (name: string, maximum: number, required = false): string | undefined => {
            const value = body?.[name];
            if (value === undefined && !required) return undefined;
            if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, `invalid_${name}`);
            return value.trim();
          };
          const event = {
            id: field('id', 200, true)!, type: field('type', 64, true)!,
            ...(field('subject', 100) ? { subject: field('subject', 100)! } : {}),
            ...(field('summary', 200) ? { summary: field('summary', 200)! } : {}),
            ...(field('detail', 4000) ? { detail: field('detail', 4000)! } : {}),
            ...(field('link', 500) ? { link: field('link', 500)! } : {})
          };
          sendJson(res, 200, await autoloop.emit(event));
          liveEvents.publish('autoloop');
          return;
        }
        const autoloopCardMatch = /^\/api\/autoloop\/cards\/(\d+)\/answer$/.exec(url.pathname);
        if (autoloopCardMatch && req.method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const choice = body?.choice === undefined ? undefined : Number(body.choice);
          const text = typeof body?.text === 'string' ? body.text : undefined;
          if (choice !== undefined && (!Number.isInteger(choice) || choice < 0)) throw new HttpError(400, 'invalid_choice');
          sendJson(res, 200, autoloop.answer(Number(autoloopCardMatch[1]), { ...(choice === undefined ? {} : { choice }), ...(text === undefined ? {} : { text }) }));
          liveEvents.publish('autoloop');
          return;
        }
        if (url.pathname === '/api/lulu/submit' && req.method === 'POST') {
          if (!luluService?.enabled) throw new HttpError(503, 'lulu_not_configured');
          const body = await readJsonBody(req) as Record<string, unknown>;
          const field = (name: string, maximum: number): string => {
            const value = body?.[name];
            if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, `invalid_${name}`);
            return value.trim();
          };
          const platform = field('platform', 40);
          const conversationId = field('conversationId', 200);
          const message = field('message', 4000);
          const sender = body?.sender === undefined ? undefined : field('sender', 40);
          try {
            sendJson(res, 200, await luluService.submit({ platform, conversationId, message, ...(sender ? { sender } : {}) }));
            liveEvents.publish('lulu');
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : 'lulu_submit_invalid');
          }
          return;
        }
        const luluRunMatch = /^\/api\/lulu\/runs\/([^/]+)$/.exec(url.pathname);
        if (luluRunMatch && req.method === 'GET') {
          const record = luluService?.run(decodeURIComponent(luluRunMatch[1]));
          if (!record) throw new HttpError(404, 'lulu_run_not_found');
          sendJson(res, 200, { runId: record.runId, status: record.status, evidence: record.evidence, completedAt: record.completedAt });
          return;
        }
        if (url.pathname === '/api/real/codex' && req.method === 'POST') {
          if (!codexProbe.enabled) throw new HttpError(503, 'codex_probe_not_configured');
          const body = await readJsonBody(req) as { prompt?: unknown };
          if (typeof body?.prompt !== 'string') throw new HttpError(400, 'invalid_request');
          try { sendJson(res, 202, codexProbe.start(body.prompt)); liveEvents.publish('codex'); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid_request'); }
          return;
        }
        const codexMatch = /^\/api\/real\/codex\/([^/]+)$/.exec(url.pathname);
        if (codexMatch && req.method === 'GET') {
          const run = codexProbe.get(decodeURIComponent(codexMatch[1]));
          if (!run) throw new HttpError(404, 'codex_run_not_found');
          sendJson(res, 200, run);
          return;
        }
        if (url.pathname === '/api/project/status' && req.method === 'GET') {
          sendJson(res, 200, {
            enabled: !!projectCoordinator, readonlyModels: true, mergeEnabled: false,
            reason: projectStatusReason
          });
          return;
        }
        if (url.pathname === '/api/project/pricing' && req.method === 'GET') {
          const price = DEEPSEEK_PEAK_CNY;
          const body: ProjectPricingView = {
            currency: price.currency,
            current: Date.now() >= price.checkedAtMs && Date.now() < price.expiresMs,
            checkedAt: new Date(price.checkedAtMs).toISOString(),
            expiresAt: new Date(price.expiresMs).toISOString(),
            source: price.source,
            peak: {
              flashInputMissMinorPerMillion: price.models['deepseek-flash'].inputMissMinorPerMillion,
              flashOutputMinorPerMillion: price.models['deepseek-flash'].outputMinorPerMillion,
              proInputMissMinorPerMillion: price.models['deepseek-v4-pro'].inputMissMinorPerMillion,
              proOutputMinorPerMillion: price.models['deepseek-v4-pro'].outputMinorPerMillion,
              searchOrFetchMinorPerThousand: price.searchOrFetchMinorPerThousand
            },
            pricingIsHardSpendingCap: false, modelExecutionIsolated: false
          };
          sendJson(res, 200, body);
          return;
        }
        if (url.pathname === '/api/tasks' && req.method === 'POST') {
          const body = await readJsonBody(req);
          if (initialized && principal && !principal.rootAdministrator) {
            const task = body as Record<string, unknown> | null;
            if (!task || typeof task !== 'object' || Array.isArray(task) ||
                (task.mode !== 'fixture' && task.mode !== undefined) ||
                Object.keys(task).some(key => !['title','goal','mode'].includes(key))) {
              throw new HttpError(403, 'tenant_only_offline_fixture_tasks');
            }
          }
          try {
            const result = routes.create(body as CreateTaskInput);
            if (initialized && principal) identityStore().bindTask(principal, result.taskId,
              String((body as CreateTaskInput)?.mode ?? 'fixture'));
            sendJson(res, 202, result);
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'invalid_request';
            if (reason === 'project_preview_not_configured') throw new HttpError(503, reason);
            if (reason.startsWith('project_') || reason === 'invalid_task_mode') throw new HttpError(400, reason);
            throw error;
          }
          return;
        }
        const previewMatch = /^\/api\/tasks\/([^/]+)\/project-preview$/.exec(url.pathname);
        if (previewMatch && req.method === 'GET') {
          try {
            const preview = routes.projectPreview(decodeURIComponent(previewMatch[1]));
            if (!preview) throw new HttpError(404, 'project_preview_not_found');
            sendJson(res, 200, preview);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, error instanceof Error && error.message === 'project_preview_not_completed'
              ? 'project_preview_not_completed' : 'project_preview_integrity_failed');
          }
          return;
        }
        const deliveryMatch = /^\/api\/tasks\/([^/]+)\/delivery$/.exec(url.pathname);
        if (deliveryMatch && req.method === 'GET') {
          try {
            const delivery = routes.delivery(decodeURIComponent(deliveryMatch[1]));
            if (!delivery) throw new HttpError(404, 'local_delivery_not_found');
            sendJson(res, 200, delivery);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, error instanceof Error && error.message === 'local_delivery_not_completed'
              ? 'local_delivery_not_completed' : 'local_delivery_integrity_failed');
          }
          return;
        }
        const graphMatch = /^\/api\/tasks\/([^/]+)\/execution-graph$/.exec(url.pathname);
        if (graphMatch && req.method === 'GET') {
          const taskId = decodeURIComponent(graphMatch[1]);
          const detail = routes.detail(taskId);
          if (!detail) throw new HttpError(404, 'task_not_found');
          const crew = findCrewContext(crewPlans().list(), taskId, (id) => routes.detail(id)?.status ?? null);
          sendJson(res, 200, buildExecutionGraph({
            detail,
            crew,
            agents: platformAgents().list(),
            bindings: principal ? modelBindings().list(principal.tenantId) : [],
            gatewayRequests: gatewayRequests().recordsForTask(taskId),
            generatedAt: new Date().toISOString()
          }));
          return;
        }
        const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
        if (taskMatch && req.method === 'GET') {
          const detail = routes.detail(decodeURIComponent(taskMatch[1]));
          if (!detail) throw new HttpError(404, 'task_not_found');
          sendJson(res, 200, detail);
          return;
        }
        const reconcileMatch = /^\/api\/tasks\/([^/]+)\/reconcile$/.exec(url.pathname);
        if (reconcileMatch && req.method === 'POST') {
          if (initialized && principal && !principal.rootAdministrator) {
            throw new HttpError(403, 'tenant_reconciliation_not_enabled');
          }
          try {
            const body = await readJsonBody(req);
            sendJson(res, 200, routes.reconcile(decodeURIComponent(reconcileMatch[1]), body as Record<string, unknown>));
          } catch (error) {
            if (error instanceof Error && error.message === 'Unknown task') throw new HttpError(404, 'task_not_found');
            throw new HttpError(409, error instanceof Error ? error.message : 'reconciliation_failed');
          }
          return;
        }
        const approveMatch = /^\/api\/tasks\/([^/]+)\/approve$/.exec(url.pathname);
        if (approveMatch && req.method === 'POST') {
          if (initialized && principal && !principal.rootAdministrator &&
              identityStore().taskMode(principal, approveMatch[1]) !== 'fixture') {
            throw new HttpError(403, 'tenant_only_offline_fixture_tasks');
          }
          try {
            sendJson(res, 200, routes.approve(decodeURIComponent(approveMatch[1])));
          } catch (error) {
            if (error instanceof Error && error.message === 'Unknown task') throw new HttpError(404, 'task_not_found');
            throw new HttpError(409, error instanceof Error ? error.message : 'approval_failed');
          }
          return;
        }
        const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
        if (cancelMatch && req.method === 'POST') {
          const task = routes.cancel(decodeURIComponent(cancelMatch[1]));
          if (!task) throw new HttpError(404, 'task_not_found');
          sendJson(res, 200, task);
          return;
        }
        if (url.pathname === '/api/events' && req.method === 'GET') {
          if (!String(req.headers.accept ?? '').includes('text/event-stream')) throw new HttpError(406, 'event_stream_required');
          if (!liveEvents.subscribe(res, () => getRequestSession(req.headers.cookie)?.id === session.id)) {
            throw new HttpError(503, 'too_many_live_connections');
          }
          return;
        }
        throw new HttpError(404, 'not_found');
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError || error instanceof IdentityError) sendError(res, error.status, error.message);
        else if (error instanceof Error && /length invalid|must be text|invalid|required|Request body/.test(error.message)) sendError(res, 400, 'invalid_request');
        else sendError(res, 500, 'internal_error');
      }
    };

    server = createServer((req, res) => { void handler(req, res); });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (req, socket) => {
      const host = req.headers.host;
      const session = getRequestSession(req.headers.cookie);
      const origin = req.headers.origin;
      if (!host || !allowedHosts.has(host) || !session || !req.url || !req.url.startsWith('/api/events') || (origin !== undefined && !allowedOrigins.has(origin))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => { server!.off('listening', onListening); rejectListen(error); };
      const onListening = () => { server!.off('error', onError); resolveListen(); };
      server!.once('error', onError);
      server!.once('listening', onListening);
      server!.listen(port, '127.0.0.1');
    });
    const address = server.address() as AddressInfo;
    if (address.address !== '127.0.0.1') throw new Error('HTTP Host must bind to 127.0.0.1');
    expectedOrigin = `http://127.0.0.1:${address.port}`;
    allowedOrigins.add(expectedOrigin);
    allowedOrigins.add(`http://localhost:${address.port}`);
    for (const origin of options.allowedDevOrigins ?? []) allowedOrigins.add(origin);
    allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);

    return {
      url: `${expectedOrigin}/`,
      port: address.port,
      address: address.address,
      bootstrapToken,
      ...(options.readOnlyBootstrapToken ? { readOnlyBootstrapToken: options.readOnlyBootstrapToken } : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(autoloopTimer);
        clearInterval(notificationTimer);
        liveEvents.close();
        routes.cancelAll();
        await routes.drain();
        server!.closeAllConnections();
        await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
        await codexWeb!.close();
        autoloop.close();
        await agentGraph.close();
        missionControl.close();
        tenantBudgetLedger?.close();
        modelBindingStore?.close();
        projectInputStore?.close();
        identityRegistry?.close();
        await magpieStartup;
        magpie.stop();
        operations.close();
        store!.close();
        await lock.close();
      }
    };
  } catch (error) {
    liveEvents.close();
    if (server) {
      try { server.closeAllConnections(); server.close(); } catch { /* ignore */ }
    }
    if (activeTimer) clearInterval(activeTimer);
    try { await codexWeb?.close(); } catch { /* startup interrupted */ }
    try { ownedAutoloop?.close(); } catch { /* startup interrupted */ }
    try { await ownedAgentGraph?.close(); } catch { /* startup interrupted */ }
    try { ownedMission?.close(); } catch { /* startup interrupted */ }
    try { tenantBudgetLedger?.close(); } catch { /* startup interrupted */ }
    try { modelBindingStore?.close(); } catch { /* startup interrupted */ }
    try { projectInputStore?.close(); } catch { /* startup interrupted */ }
    try { ownedIdentityRegistry?.close(); } catch { /* startup interrupted */ }
    await pendingStartup?.catch(() => undefined);
    try { ownedMagpie?.stop(); } catch { /* startup interrupted */ }
    try { operationJournal?.close(); } catch { /* startup interrupted */ }
    store?.close();
    await lock.close().catch(() => undefined);
    throw error;
  }
}

export { SessionManager } from './auth.ts';
export type { Session } from './auth.ts';
