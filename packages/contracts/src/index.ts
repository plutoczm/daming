/** Public read model. The API status enum will be versioned with the Engine in Task 1. */
export interface TaskView {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

export type TaskStatus =
  | 'draft'
  | 'planned'
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface BudgetView {
  readonly currency: 'CNY';
  readonly limitMinor: number;
  readonly spentMinor: number;
  readonly heldMinor: number;
  readonly breached: boolean;
}

export interface TaskProgressView {
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly assignmentCount: number;
  readonly reviewCount: number;
}

export interface TaskSummaryView {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly budget: BudgetView | null;
  readonly progress: TaskProgressView;
}

export interface TaskStepView {
  readonly stepId: string;
  readonly description: string;
  readonly workerId: string;
  readonly dependsOn: readonly string[];
  readonly maxReworks: number;
}

export interface TaskAssignmentView {
  readonly assignmentId: string;
  readonly stepId: string;
  readonly workerId: string;
  readonly stepAttempt: number;
  readonly effectStatus: string;
  /** Persisted effect id (outbox), so a tool node is traceable to the governance audit. */
  readonly effectId?: string;
  readonly deliveryStatus: string | null;
  readonly reviewVerdict: string | null;
  readonly artifactKeys: readonly string[];
  readonly resultPreview: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface TaskDecisionView {
  readonly sequence: number;
  readonly reason: string;
  readonly samples: number;
  readonly previousConcurrency: number;
  readonly nextConcurrency: number;
}

export interface TaskReviewView {
  readonly assignmentId: string;
  readonly verdict: string;
  readonly reasons: readonly string[];
}

export interface WorkerExclusionView {
  readonly workerId: string;
  readonly reasons: readonly string[];
}

export interface WorkerRouteView {
  readonly stepId: string;
  readonly assignedWorkerId: string;
  readonly selectedWorkerId: string | null;
  readonly eligibleWorkerIds: readonly string[];
  readonly excluded: readonly WorkerExclusionView[];
}

export interface ApprovalView {
  readonly operationId: string;
  readonly status: string;
  readonly expiresAt: string;
}

export interface TaskEventView {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly sourceId: string;
}

export interface GovernanceAuditView {
  readonly sequence: number | null;
  readonly type: string;
  readonly at: string;
  readonly amountMinor: number | null;
}

export interface ReconciliationView {
  readonly operationId: string;
  readonly billingSource: string;
  readonly heldCashMinor: number;
  readonly maximumCashMinor: number;
  readonly reason: string | null;
}

export interface TaskDetailView extends TaskSummaryView {
  readonly blockedReason: string | null;
  readonly plan: {
    readonly planId: string;
    readonly version: number;
    readonly category: string;
    readonly policyVersion: string;
    readonly steps: readonly TaskStepView[];
  } | null;
  readonly assignments: readonly TaskAssignmentView[];
  readonly reviews: readonly TaskReviewView[];
  readonly decisions: readonly TaskDecisionView[];
  readonly workerRoutes: readonly WorkerRouteView[];
  readonly approvals: readonly ApprovalView[];
  readonly reconciliations: readonly ReconciliationView[];
  readonly events: readonly TaskEventView[];
  readonly audit: readonly GovernanceAuditView[];
}

export interface CreateTaskInput {
  readonly title: string;
  readonly goal: string;
  readonly limitMinor?: number;
  readonly mode?: 'fixture' | 'local' | 'project' | 'real' | 'dsh' | 'claude';
  readonly filePaths?: readonly string[];
}

export interface CreateTaskResult {
  readonly taskId: string;
}

export interface ProjectPreviewView {
  readonly taskId: string;
  readonly filename: string;
  readonly before: string;
  readonly after: string;
  readonly reviewerNote: string;
  readonly originalUnchanged: boolean;
  readonly verified: boolean;
  readonly mergeEnabled: false;
}

export interface ProjectAgentStatusView {
  readonly enabled: boolean;
  readonly readonlyModels: true;
  readonly mergeEnabled: false;
  readonly reason: string;
}

export interface ProjectPricingView {
  readonly currency: 'CNY';
  readonly current: boolean;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly source: string;
  readonly peak: {
    readonly flashInputMissMinorPerMillion: number;
    readonly flashOutputMinorPerMillion: number;
    readonly proInputMissMinorPerMillion: number;
    readonly proOutputMinorPerMillion: number;
    readonly searchOrFetchMinorPerThousand: number;
  };
  readonly pricingIsHardSpendingCap: false;
  readonly modelExecutionIsolated: false;
}

export interface TaskDeliveryView {
  readonly taskId: string;
  readonly filename: 'report.md';
  readonly content: string;
  readonly verified: true;
}

export interface SessionView {
  readonly mfaEnabled?: boolean;
  /** True in desktop fixed-user mode: this machine is already signed in as its owner. */
  readonly localMode?: boolean;
  readonly csrfToken: string;
  readonly role: 'readwrite' | 'readonly';
  readonly expiresAt: string;
  readonly identity?: {
    readonly userId: string;
    readonly username: string;
    readonly tenantId: string;
    readonly tenantName: string;
    readonly memberRole: 'owner' | 'operator' | 'viewer';
    readonly rootAdministrator: boolean;
  };
}

export interface ApiErrorView {
  readonly error: string;
  readonly reason: string;
}

export interface LuluStatusView {
  readonly enabled: boolean;
  readonly health: 'online' | 'unavailable' | 'unknown';
  readonly capabilities: 'available' | 'unauthorized' | 'unavailable' | 'disabled';
  readonly checkedAt: string;
  readonly coachPrimary?: string;
  readonly agentPrimary?: string;
  readonly fastModel?: string;
  readonly memoryModel?: string;
  readonly reason?: string;
}

export interface AutoloopCardView {
  readonly id: number;
  readonly kind: 'ask' | 'notice';
  readonly state: string;
  readonly title: string;
  readonly text: string;
  readonly options: readonly string[];
}

export interface AutoloopRunView {
  readonly id: number;
  readonly rule: string;
  readonly agent: string;
  readonly state: string;
  readonly createdAt: string;
  readonly summary?: string;
}

export interface AutoloopAgentHealthView {
  readonly id: string;
  readonly status: 'available' | 'unavailable';
  readonly reason: string;
}

export interface AutoloopStateView {
  readonly enabled: boolean;
  readonly agentHealth: readonly AutoloopAgentHealthView[];
  readonly totals: { readonly running: number; readonly queued: number; readonly done: number; readonly cards: number };
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  readonly agents: readonly { readonly id: string; readonly name: string; readonly use: string; readonly worker: string }[];
  readonly channels: readonly { readonly id: string; readonly name: string }[];
  readonly rules: readonly { readonly name: string; readonly when: string; readonly to: string }[];
  readonly runs: readonly AutoloopRunView[];
  readonly cards: readonly AutoloopCardView[];
}

export interface MagpieItemView {
  readonly name: string;
  readonly id?: string;
  readonly status?: 'ready' | 'disabled' | 'needs_setup' | 'error';
  readonly kind?: string;
  readonly detail?: string;
  readonly version?: string;
  readonly latest?: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
  readonly installedSpec?: string;
}

export interface MagpieReadView {
  readonly alias: string;
  readonly count: number | null;
  readonly labels: readonly string[];
  readonly items: readonly MagpieItemView[];
  readonly checkedAt: string;
}

export interface MagpieCheckinSummaryView {
  readonly total: number;
  readonly claimed: number;
  readonly already: number;
  readonly captcha: number;
  readonly failed: number;
  readonly other: number;
  readonly creditsReported: number;
}

export interface MagpieActionView {
  readonly action: string;
  readonly completed: boolean;
  readonly checkedAt: string;
  readonly result?: 'succeeded' | 'partial' | 'failed' | 'no_accounts' | 'needs_attention';
  readonly checkin?: MagpieCheckinSummaryView;
}

export type MagpieOperationRisk = 'medium' | 'high';
export type MagpieOperationStatus = 'prepared' | 'executing' | 'succeeded' | 'partial' | 'failed' | 'no_accounts' | 'needs_attention' | 'unknown' | 'expired' | 'cancelled' | 'reconciled';

export interface MagpieOperationView {
  readonly id: string;
  readonly action: string;
  readonly risk: MagpieOperationRisk;
  readonly target?: string;
  readonly status: MagpieOperationStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly checkin?: MagpieCheckinSummaryView;
  readonly reason?: string;
  readonly resolution?: 'succeeded' | 'not_executed';
}

export interface MagpiePreparationView {
  readonly operation: MagpieOperationView;
  readonly approvalToken: string;
}

export interface MagpieStatusView {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly configured: boolean;
  readonly version: string;
  readonly port?: number;
  readonly adminPort?: number;
  readonly migratedFrom?: 1;
  readonly instanceId?: string;
  readonly profile?: 'default' | 'selected' | 'environment';
  readonly checkedAt: string;
  readonly health?: string;
  readonly reason?: string;
}

export interface DeepSeekBalanceView {
  readonly configured: boolean;
  readonly available: boolean;
  readonly currency: string | null;
  readonly totalMinor: number | null;
  readonly grantedMinor: number | null;
  readonly toppedUpMinor: number | null;
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface LuluSubmitView {
  readonly status: 'completed' | 'unauthorized' | 'rejected' | 'unavailable' | 'duplicate';
  readonly runId?: string;
  readonly evidence?: unknown;
  readonly reason?: string;
}

export interface RealCodexEventView {
  readonly type: string;
  readonly at: string;
  readonly itemType?: string;
  readonly text?: string;
  readonly status?: string;
  readonly error?: string;
}

export interface RealCodexRunView {
  readonly runId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  readonly prompt: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly output: string;
  readonly events: readonly RealCodexEventView[];
  readonly error?: string;
}

/** Unified, versioned event projection for the Daming command room (offline demonstration only). */
export type MissionState = 'pending_event' | 'awaiting_decision' | 'executing' | 'completed' | 'cancelled' | 'blocked';
export type MissionNodeState = 'pending' | 'running' | 'completed' | 'waiting' | 'skipped';
export interface MissionNodeView {
  readonly id: string;
  readonly name: string;
  readonly owner: 'daming' | 'superagent' | 'autoloop' | 'magpie' | 'worker';
  readonly role: string;
  readonly status: MissionNodeState;
  readonly dependsOn: readonly string[];
  readonly modelRoute: 'unbound';
}
export interface MissionEventView {
  readonly sequence: number;
  readonly missionId: string;
  readonly schemaVersion: 1;
  readonly source: 'daming' | 'superagent' | 'autoloop' | 'magpie' | 'worker';
  readonly type: string;
  readonly nodeId?: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly execution: 'offline-demo';
}
export interface MissionView {
  readonly missionId: string;
  readonly title: string;
  readonly goal: string;
  readonly mode: 'offline-demo';
  readonly status: MissionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cardId: number | null;
  readonly nodes: readonly MissionNodeView[];
  readonly events: readonly MissionEventView[];
  readonly delivery: string | null;
  readonly blockedReason: string | null;
  readonly notification: { readonly channel: 'feishu'; readonly state: 'preview_only'; readonly sent: false };
  readonly routeAuthorization: MissionRouteAuthorizationView | null;
  readonly routeAttempts: readonly MissionRouteAttemptView[];
  readonly routeReceipts: readonly MissionRouteReceiptView[];
}
export interface MissionRouteAttemptView {
  readonly attemptId: string;
  readonly authorizationId: string;
  readonly state: 'prepared' | 'cancelled' | 'unknown_after_send' | 'settled_synthetic' | 'breached_synthetic';
  readonly outputTokenCeiling: number;
  readonly budgetEnvelopeMinor: number;
  readonly createdAt: string;
  readonly modelRequestSent: false | 'possible';
}
/** Host-only simulation ledger projected without keys, owner identifiers or evidence payloads. */
export interface MissionRouteReceiptView {
  readonly attemptId: string;
  readonly state: 'unknown_after_send' | 'settled_synthetic' | 'breached_synthetic';
  readonly priceBasisId: string;
  readonly priceCeilingMinor: number;
  readonly reservedEnvelopeMinor: number;
  readonly observedCashMinor: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly vendorInvoiceVerified: false;
  readonly productionDispatchEnabled: false;
}
export interface PrepareMissionRouteAttemptInput {
  readonly requestId: string;
  readonly outputTokenCeiling: number;
  readonly budgetEnvelopeMinor: number;
}
export interface MagpieRouteCandidateView {
  readonly candidateId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountType: 'single-api-key' | 'api-key';
  readonly accountLabel: string;
}
export interface MagpieRouteCatalogView {
  readonly source: 'magpie';
  readonly status: 'ready' | 'unavailable';
  readonly candidates: readonly MagpieRouteCandidateView[];
  readonly accountIdentityExposed: false;
  readonly dispatchEnabled: false;
  readonly checkedAt: string;
}
export interface MissionRouteAuthorizationView {
  readonly authorizationId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly state: 'authorized' | 'revoked' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly maxRequests: number;
  readonly maxOutputTokens: number;
  readonly maxCashMinor: number;
  readonly dispatchEnabled: false;
}
export interface CreateMissionRouteAuthorizationInput {
  readonly requestId: string;
  readonly candidateId: string;
  readonly ttlMinutes: number;
  readonly maxRequests: number;
  readonly maxOutputTokens: number;
  readonly maxCashMinor: number;
}
export interface MissionRouteScopeProbeView {
  readonly missionId: string;
  readonly verified: boolean;
  readonly keyRevoked: boolean;
  readonly dispatchPermitted: false;
  readonly reason: string;
}
export interface MissionRoutePreflightView {
  readonly missionId: string;
  readonly authorizationId: string | null;
  readonly accountBindingValid: boolean;
  readonly dispatchPermitted: false;
  readonly reason: string;
  readonly productionBlockers: readonly string[];
}
export interface MissionResourceView {
  readonly source: 'magpie';
  readonly configured: boolean;
  readonly status: 'inventory_ready' | 'unavailable';
  readonly models: { readonly count: number | null; readonly sample: readonly string[] };
  readonly providers: { readonly count: number | null; readonly ready: number };
  readonly agents: { readonly count: number | null; readonly sample: readonly string[] };
  readonly quotas: { readonly count: number | null };
  readonly credentialsExposed: false;
  readonly dispatchEnabled: false;
}
export interface CreateMissionInput {
  readonly title: string;
  readonly goal: string;
  readonly requestId: string;
  readonly mode: 'offline-demo';
}

/** No network transport is enabled; this is a safe channel-agnostic decision-card preview. */
export interface MissionNotificationPreviewView {
  readonly missionId: string;
  readonly version: 1;
  readonly cardId: number | null;
  readonly title: string;
  readonly text: string;
  readonly actions: readonly { readonly choice: 0 | 1; readonly label: string }[];
  readonly channels: readonly {
    readonly id: 'feishu' | 'wecom' | 'wechat' | 'qq';
    readonly interactive: boolean;
    readonly configured: false;
    readonly sent: false;
  }[];
  readonly requiresVerifiedUserIdentity: true;
  readonly requiresSignedCallback: true;
  readonly sent: false;
}
/** Single explicit text send; model completion does not settle subscription cash. */
export interface CodexApprovalTaskView {
  readonly taskId: string;
  readonly prompt: string;
  readonly model: 'codex/gpt-6.1-sol';
  readonly accountLabel: string;
  readonly limitMinor: number;
  readonly expiresAt: string;
  readonly status: TaskStatus;
  readonly approvalAvailable: boolean;
  readonly approvalUnavailableReason: string | null;
  readonly recoveryRequired: boolean;
  readonly cashHeldMinor: number;
  readonly cashChargedMinor: null;
  readonly modelStatus: string | null;
  readonly output: string;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly automaticRetry: false;
}

// ── S5：LLM/Agent 统筹（统一模型目录 + 选模型绑定 Agent + 派工注入） ──
// 仅脱敏视图：不含令牌、账号登录名、供应商 URL、原始 key 指纹或计费明细。
export type AgentTarget = 'dsh' | 'codex' | 'claude-code';
export type ModelSourceKind = 'subscription' | 'official_api' | 'relay' | 'local';
export type ModelBillingBasis = 'cash' | 'quota';
export interface ModelQuotaWindowView {
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}
export interface AvailableModelView {
  readonly modelId: string;
  readonly providerId: string;
  readonly sourceKind: ModelSourceKind;
  readonly billing: ModelBillingBasis;
  readonly quota: ModelQuotaWindowView;
  readonly dispatchable: boolean;
  readonly reason?: string;
}
export interface AvailableModelsView {
  readonly tenantId: string;
  readonly models: readonly AvailableModelView[];
  readonly checkedAt: string;
  readonly dispatchEnabled: false;
}
export interface ModelBindingScopeView {
  readonly kind: 'tenant' | 'task';
  readonly taskId?: string;
}
export interface ModelBindingView {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly agent: AgentTarget;
  readonly modelId: string;
  readonly providerId: string;
  readonly sourceKind: ModelSourceKind;
  readonly billing: ModelBillingBasis;
  readonly scope: ModelBindingScopeView;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly revokedAt?: string;
}
export interface BindModelInputView {
  readonly agent: AgentTarget;
  readonly modelId: string;
  readonly scope: ModelBindingScopeView;
}

// ── S14：顶层组合治理（人仅管理/审核/决策）；P0 只读视图，无副作用 ──
// 一个用户可持有多个项目，平台把待拍板项聚合成一个组合级收件箱。
export type AutonomyMode = 'auto' | 'managed' | 'supervised';
export type PortfolioRiskLevel = 'low' | 'medium' | 'high';
/** 决策税五类：A 契约 / B 验收 / C 预算 / D 不可逆 / E 异常。 */
export type EscalationKind = 'contract' | 'acceptance' | 'budget' | 'irreversible' | 'anomaly';
export type EscalationBucket = 'needs_you' | 'at_risk' | 'awaiting_acceptance' | 'healthy';
/** 超时时执行的“安全默认动作”：绝不自动做不可逆动作。 */
export type EscalationDefaultAction = 'hold' | 'pause' | 'advance' | 'reject';

/** 每项目授权档位：开工时一次性设定，“少管”的主开关。 */
export interface AutonomyProfileView {
  readonly projectId: string;
  readonly mode: AutonomyMode;
  /** 单笔/阶段金额自动上限（最小币种）；null=任何花费都要问。 */
  readonly spendCapMinor: number | null;
  /** 风险在此级别及以下自动；高于才升级。 */
  readonly riskCap: PortfolioRiskLevel;
  /** Agent 信心下限（0..1）；低于才升级。 */
  readonly confidenceFloor: number;
  /** 证据 PASS 时自动验收；仅 auto 档允许为 true。 */
  readonly autoAccept: boolean;
  /** 每项目每天实时打扰上限（非关键项超出即并入 digest）。 */
  readonly maxInterruptsPerDay: number;
}

/** 由 Host 从真实 Project 投影出的组合视图；不携带密钥/令牌。 */
export interface PortfolioProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly goal: string;
  readonly accepted: boolean;
  readonly pendingDecisions: readonly {
    readonly decisionId: string;
    readonly kind: 'clarification' | 'proposal' | 'acceptance';
    readonly question: string;
  }[];
  readonly blockers: readonly { readonly id: string; readonly severity: PortfolioRiskLevel }[];
  readonly stalledMinutes: number;
  readonly consecutiveFailures: number;
  /** 待授权的不可逆操作（发布/合并主干/删除/付款）；永不自动。 */
  readonly irreversiblePending?: readonly { readonly id: string; readonly summary: string }[];
  readonly budget: {
    readonly spentMinor: number;
    readonly capMinor: number | null;
    readonly unknown: boolean;
  } | null;
  /** 确定性验收证据是否已 PASS（自动验收门槛，REQ-009）。 */
  readonly evidencePassed: boolean;
  readonly lastActivityAt: string;
}

/** 一条待拍板项：一句话 + 推荐动作 + 影响 + 超时安全默认。 */
export interface EscalationItemView {
  readonly itemId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly kind: EscalationKind;
  readonly severity: PortfolioRiskLevel;
  readonly bucket: EscalationBucket;
  readonly summary: string;
  readonly recommendation: string;
  readonly impact: string;
  readonly evidence: readonly string[];
  readonly defaultAction: EscalationDefaultAction;
  /** true=实时推送（关键生命线）；false=并入 digest。 */
  readonly realtime: boolean;
  readonly createdAt: string;
  readonly deadlineAt: string;
}

/** 跨项目组合收件箱（一次看全部项目）。 */
export interface PortfolioDigestView {  readonly dayKey: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly projects: number;
    readonly needsYou: number;
    readonly atRisk: number;
    readonly awaitingAcceptance: number;
    readonly healthy: number;
  };
  readonly realtime: readonly EscalationItemView[];
  readonly digest: readonly EscalationItemView[];
  /** 系统替人做出的自动决定（如自动验收）与降噪说明，供审计回看。 */
  readonly autoHandled: readonly string[];
  readonly notes: readonly string[];
}

// ── 平台目录：供应商 / Agent 档案 / LLM 切换（配置驱动，不依赖桌面 App） ──
export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
/** 供应商配置（密钥只以环境变量名 apiKeyEnv 表达，不含明文）。 */
export interface ProviderConfigView {
  readonly id: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly apiKeyEnv?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly weight?: number;
}
/** Agent 档案（一等对象）：runtime 是 CLI Harness，模型来自供应商。 */
export interface AgentProfileView {
  readonly agentId: string;
  readonly name: string;
  readonly runtime: AgentTarget;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly instructions?: string;
  readonly createdAt: string;
}
export interface PlatformCatalogView {
  readonly providers: readonly ProviderConfigView[];
  readonly agents: readonly AgentProfileView[];
  readonly defaultModel: string | null;
}

// ── 网关观测：请求明细 / 上下文构成 / 脱敏汇总（对齐 Magpie 观测面） ──
export type GatewayContextCategory = 'system' | 'tools' | 'skills' | 'memory' | 'files' | 'tool_results' | 'conversation' | 'other';
export interface GatewayContextPartView {
  readonly label: string;
  readonly category: GatewayContextCategory;
  readonly tokens: number;
}
export interface GatewayRequestView {
  readonly requestId: string;
  readonly at: string;
  readonly agent: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: 'ok' | 'error';
  readonly latencyMs: number;
  readonly firstTokenMs?: number;
  readonly outputTokenPerSec?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitPercent?: number;
  readonly costMinor?: number;
  readonly maskedCount: number;
  readonly error?: string;
  readonly contextLimitTokens?: number;
  readonly contextParts?: readonly GatewayContextPartView[];
  /**
   * Task attribution. Only present when the caller explicitly sent
   * `X-Daming-Task-Id` and the gateway recorded it; Agent CLIs that do not send
   * the header stay unattributed instead of being guessed from the model name.
   */
  readonly taskId?: string;
  readonly attribution: 'task' | 'unattributed';
}
export interface GatewaySummaryView {
  readonly requests: number;
  readonly errors: number;
  readonly avgLatencyMs: number;
  readonly cacheHitPercentAvg: number;
  readonly totalCostMinor: number;
  readonly maskedTotal: number;
}
export interface GatewayObservabilityView {
  readonly generatedAt: string;
  readonly summary: GatewaySummaryView;
  readonly requests: readonly GatewayRequestView[];
}
export interface GatewayContextCompositionView {
  readonly requestId: string;
  readonly usedTokens: number;
  readonly limitTokens: number | null;
  readonly remainingPercent: number | null;
  readonly cacheHitPercent: number | null;
  readonly parts: readonly { readonly label: string; readonly category: GatewayContextCategory; readonly tokens: number; readonly percent: number }[];
}

// ── 编队视图（父任务 → 子任务树）：从持久化派发回执恢复，不依赖前端临时状态 ──
export type CrewAgentRole = 'dsh' | 'codex' | 'claude-code';
export interface CrewAssignmentView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly agent: CrewAgentRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly mode: string;
  readonly rationale: string;
  /** 成本档：low / mid / high（按可派工模型的计费与额度推算）。 */
  readonly costTier?: 'low' | 'mid' | 'high';
  readonly ready: boolean;
  /** Planned dependency on earlier assignments (advisory: the engine does not serialise). */
  readonly dependsOn: readonly string[];
}
/** 一个子目标的当前状态：来自派发回执 + 真实任务存储，不含推测。 */
export interface CrewChildView {
  readonly assignmentId: string;
  readonly taskId: string;
  readonly title: string;
  /** null=该 taskId 在持久化任务库里已不存在（例如测试数据被清理）。 */
  readonly status: TaskStatus | null;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly agent: CrewAgentRole;
  readonly modelId: string;
  readonly binding: 'bound' | 'unbound';
  readonly dispatchedAt: string;
  readonly updatedAt: string | null;
  readonly blockedReason: string | null;
  /** Planned predecessors that are not delivered yet (advisory, from persisted statuses). */
  readonly waitingOn: readonly string[];
}
export interface CrewPlanView {
  readonly planId: string;
  readonly title: string;
  readonly goal: string;
  readonly planner: 'platform' | 'main-agent';
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly assignments: readonly CrewAssignmentView[];
  readonly notes: readonly string[];
  readonly children: readonly CrewChildView[];
  readonly skipped: readonly { readonly assignmentId: string; readonly reason: string; readonly at: string }[];
  readonly progress: {
    readonly dispatched: number;
    readonly running: number;
    readonly completed: number;
    readonly blocked: number;
    readonly failed: number;
    readonly pending: number;
  };
}
export interface CrewOverviewView {
  readonly generatedAt: string;
  readonly plans: readonly CrewPlanView[];
}

// ── 多 Agent 执行图（UI v4）：只读投影，来自已持久化的任务/编队/档案/绑定记录 ──
export type ExecutionNodeKind =
  | 'goal' | 'orchestrator' | 'planner' | 'agent' | 'executor' | 'model'
  | 'tool' | 'artifact' | 'review' | 'delivery' | 'handoff';
export type ExecutionNodeState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped' | 'unknown';
/** 证据来源：UI 用它区分“真实持久化数据”和“尚未接入”。 */
export type ExecutionEvidenceSource = 'task' | 'crew' | 'agent-profile' | 'model-binding' | 'gateway' | 'derived';
/** persisted=有持久化记录；partial=部分字段有；not_recorded=当前没有该记录。 */
export type ExecutionEvidenceState = 'persisted' | 'partial' | 'not_recorded';

export interface ExecutionNodeView {
  readonly nodeId: string;
  readonly kind: ExecutionNodeKind;
  readonly label: string;
  /** 角色/当前步骤等一句话说明。 */
  readonly detail: string | null;
  readonly state: ExecutionNodeState;
  readonly stepId: string | null;
  readonly assignmentId: string | null;
  readonly attempt: number | null;
  readonly runtime: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** 仅当 Host 有真实用量记录时才非空。 */
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly costMinor: number | null;
  readonly lastEventType: string | null;
  readonly lastEventAt: string | null;
  readonly error: string | null;
  readonly evidence: readonly ExecutionEvidenceSource[];
  /** 该节点仍有未接入的字段（UI 显示“未接入”，不编造）。 */
  readonly unknown: readonly string[];
}

export interface ExecutionEdgeView {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'dispatch' | 'handoff' | 'return' | 'review' | 'delivery' | 'tool';
  readonly state: ExecutionNodeState;
  readonly label: string;
  readonly evidence: ExecutionEvidenceSource;
}

/** 时间线事件：eventId 稳定且可去重（动画只播新事件）。 */
export interface ExecutionEventView {
  readonly eventId: string;
  readonly at: string;
  readonly type: string;
  readonly label: string;
  readonly nodeId: string | null;
  readonly state: ExecutionNodeState;
  /**
   * `task` = 任务事件流；`crew` = 派发回执；`assignment` / `review` = 由已持久化的
   * 派工时间与评审结论派生（不是推断出来的新事实）。
   */
  readonly source: 'task' | 'crew' | 'assignment' | 'review';
}

export interface ExecutionCoverageView {
  readonly modelRequests: ExecutionEvidenceState;
  readonly toolCalls: ExecutionEvidenceState;
  readonly runtimeBinding: ExecutionEvidenceState;
  readonly usage: ExecutionEvidenceState;
  readonly notes: readonly string[];
}

export interface ExecutionGraphView {
  readonly taskId: string;
  readonly generatedAt: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly nodes: readonly ExecutionNodeView[];
  readonly edges: readonly ExecutionEdgeView[];
  readonly events: readonly ExecutionEventView[];
  readonly coverage: ExecutionCoverageView;
  /** 编队上下文：该任务属于哪个编队方案。 */
  readonly crew: {
    readonly planId: string;
    readonly title: string;
    readonly planner: 'platform' | 'main-agent';
    readonly assignmentId: string;
    readonly siblings: readonly { readonly assignmentId: string; readonly taskId: string; readonly status: TaskStatus | null }[];
  } | null;
}

// ── 执行链（架构师 → 子 Agent → 评审 → 返工 → 额度/通知） ──
// 只读视图：把一条自动化执行链的架构师规划、子 Agent 执行、评审裁决、返工轮次、
// 额度消耗与人可读通知，作为可复现的观测面呈现。参照 Autoloop 的
// Planner / Coder / Reviewer + iter/metric + push log，T3 的 subagent tree，
// HiFox 的「只推需要人拍板的事」。
export type PipelineStage =
  | 'architect' | 'executing' | 'reviewing' | 'rework'
  | 'passed' | 'budget_exhausted' | 'blocked';
export interface PipelineCheckView {
  readonly id: string;
  /** 人读标签，如「交付物存在」「内容满足：实现核心功能」。 */
  readonly label?: string;
  readonly kind: 'present' | 'json_equals' | 'test';
  readonly artifactId: string;
  readonly expected?: unknown;
}
export interface PipelineCheckResultView {
  readonly id: string;
  readonly label?: string;
  readonly kind: 'present' | 'json_equals' | 'test';
  readonly passed: boolean;
  readonly reason?: string;
}
export interface PipelineReviewView {
  readonly verdict: 'pass' | 'fail' | 'needs_human';
  readonly reasons: readonly string[];
  /** 逐条评测结果（评测集的每一项是否通过）。 */
  readonly results: readonly PipelineCheckResultView[];
  readonly attempt: number;
}
/** 子 Agent 在项目协作群里的讨论/回传（离线 fixture 或真实模型注入，均为可读文本）。 */
export interface PipelineDiscussionView {
  readonly at: string;
  readonly role: 'user' | 'agent' | 'system';
  readonly name: string;
  readonly agentId?: string;
  readonly text: string;
}
export type PipelineStepStatus = 'pending' | 'running' | 'reviewing' | 'rework' | 'passed' | 'failed';
export interface PipelineStepView {
  readonly stepId: string;
  readonly title: string;
  readonly description: string;
  readonly agent: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly dependsOn: readonly string[];
  readonly maxReworks: number;
  readonly attempts: number;
  readonly status: PipelineStepStatus;
  /** 评审员为该子目标生成的评测集（验收契约）。 */
  readonly contract: readonly PipelineCheckView[];
  readonly lastReview: PipelineReviewView | null;
  /** 分配该步 Agent+模型的理由（能力 / 绑定 / 成本）。 */
  readonly rationale?: string;
  /** 成本档：low / mid / high（按可派工模型的计费与额度推算）。 */
  readonly costTier?: 'low' | 'mid' | 'high';
  /** 该步子 Agent 在项目协作群里的讨论回传（有留存的协作群时非空）。 */
  readonly discussion?: readonly PipelineDiscussionView[];
}
export interface PipelineEventView {
  readonly at: string;
  readonly stage: string;
  readonly actor: string;
  readonly text: string;
}
export interface PipelineNotificationView {
  readonly event: string;
  readonly channelHint: string;
  readonly text: string;
}
export interface PipelineRunView {
  readonly pipelineId: string;
  readonly title: string;
  readonly goal: string;
  readonly stage: PipelineStage;
  readonly iteration: number;
  readonly budgetMinor: number;
  readonly spentMinor: number;
  readonly costPerAttemptMinor: number;
  readonly architect: { readonly planner: string; readonly notes: readonly string[] };
  readonly reviewer: { readonly agent: string; readonly checks: number };
  readonly steps: readonly PipelineStepView[];
  readonly events: readonly PipelineEventView[];
  readonly notifications: readonly PipelineNotificationView[];
  /** 留存运行的 id（离线推演 simulate 没有）。 */
  readonly runId?: string;
  /** 执行来源：offline（离线 fixture）或 real（真实模型）。 */
  readonly executor?: 'offline' | 'real';
  /** 评审来源：contract（离线评测集比对）或 model（真实模型评审）。 */
  readonly reviewerKind?: 'contract' | 'model';
  /** 该执行链的项目协作群 roomId（有留存的协作群时非空）。 */
  readonly roomId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目工作台：把 Spec/Plan 落成串行阶段 + Progress.md + 功能清单 JSON。 */
export interface WorkbenchPhaseView {
  readonly phaseId: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'pending' | 'doing' | 'done';
}
export interface WorkbenchFeatureView {
  readonly id: string;
  readonly title: string;
  readonly acceptance: readonly string[];
  readonly status: 'todo' | 'doing' | 'done';
}
export interface WorkbenchProjectView {
  readonly projectId: string;
  readonly directoryPath: string;
  readonly phases: readonly WorkbenchPhaseView[];
  readonly currentPhaseIndex: number;
  readonly currentPhase: WorkbenchPhaseView | null;
  readonly done: boolean;
  readonly progressMarkdown: string;
  readonly features: readonly WorkbenchFeatureView[];
  readonly featuresPhaseId: string | null;
  readonly specCount: number;
  readonly planCount: number;
  readonly updatedAt: string;
}
export interface WorkbenchSummaryView {
  readonly projectId: string;
  readonly title: string;
  readonly phaseCount: number;
  readonly doneCount: number;
  readonly currentPhaseIndex: number;
  readonly done: boolean;
  readonly updatedAt: string;
}

/** 项目工作台 · B 阶段：隔离副本 + 验证门 + Git。 */
export interface WorkbenchGateRunView {
  readonly script: string;
  readonly command: string;
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly ms: number;
  readonly outputTail: string;
}
export interface WorkbenchVerifyView {
  readonly workspaceDir: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly results: readonly WorkbenchGateRunView[];
  readonly note?: string;
}
export interface WorkbenchGitStatusView {
  readonly workspaceDir: string;
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly configuredRemote?: string | null;
  readonly dirty: boolean;
  readonly lastCommit: string | null;
}
export interface WorkbenchCommitView {
  readonly committed: boolean;
  readonly hash?: string;
  readonly message?: string;
  readonly reason?: string;
}
export interface WorkbenchPushView {
  readonly ok: boolean;
  readonly created?: boolean;
  readonly remoteUrl?: string;
  readonly outputTail?: string;
  readonly reason?: string;
  readonly hint?: string;
}

export type GitProvider = 'github' | 'gitee';

export interface GitAccountView {
  readonly provider: GitProvider;
  readonly username: string;
  readonly hasToken: boolean;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly note?: string;
}

