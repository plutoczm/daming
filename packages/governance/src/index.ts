import type { Engine } from '@daming/core';
import type { FixtureTool,ModelRequestTool,RealTool,GovernanceRepository } from './model.ts';
import { CostLedger } from './cost-ledger.ts';
import { Approvals } from './approval.ts';
import { ToolGateway } from './tool-gateway.ts';
export { GovernanceError } from './model.ts';
export { CostLedger } from './cost-ledger.ts';
export type { ToolOperation,ModelRequestOperation,ModelRequestTool,RealTool,Operation,Budget,Quote,Approval,Reservation,Execution,GovRecords,GovernanceRepository,GovernanceAudit,FixtureTool,ToolOutcome,Reconciliation,BillingSource,UnknownHoldReduction } from './model.ts';
/** Host-only composition. Never expose admin/ledger control objects to model workers. */
export function createGovernance(options:{repository:GovernanceRepository;engine:Engine;clock?:()=>number;tools:readonly FixtureTool[];modelTools?:readonly ModelRequestTool[];realTools?:readonly RealTool[]}) {
  const clock=options.clock??Date.now;
  const ledger=new CostLedger(options.repository,clock);const approvals=new Approvals(options.repository,clock,ledger);
  const internal=new ToolGateway(options.repository,options.engine,ledger,approvals,clock,options.tools,options.modelTools??[],options.realTools??[]);
  return {
    ledger,
    gateway:Object.freeze({execute:internal.execute.bind(internal),executor:internal.executor.bind(internal)}),
    admin:Object.freeze({reduceUnknownHold:ledger.reduceUnknownHold.bind(ledger),setBudget:ledger.setBudget.bind(ledger),issueQuote:ledger.issueQuote.bind(ledger),approve:approvals.issue.bind(approvals),revoke:approvals.revoke.bind(approvals),reconcile:internal.reconcile.bind(internal),recoverInterrupted:internal.recoverInterrupted.bind(internal)})
  };
}
export { ProjectSpendLedger } from './project-spend.ts';
export type { ProjectCashEvidence, ProjectSendIntent, ProjectSendOutcome, ProjectSendPermit, ProjectSpendBudget, ProjectSpendRepository } from './project-spend.ts';
export { CheckinPolicy, evaluateOutcome, validateAuthorization } from './checkin-policy.ts';
export type { CheckinAction, CheckinAuthorization, CheckinDecision, CheckinFrequency, CheckinOutcomeKind, CheckinOutcomeStatus, CheckinOutcomeVerdict, CheckinOwner } from './checkin-policy.ts';
