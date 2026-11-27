import { randomBytes } from 'node:crypto';
import type { Approval,GovernanceRepository,Operation } from './model.ts';
import { GovernanceError } from './model.ts';
import { capabilityId,money,normalizeOperation,now,operationHash } from './binding.ts';
import type { CostLedger } from './cost-ledger.ts';
export class Approvals {
  private readonly repo:GovernanceRepository;private readonly clock:()=>number;private readonly ledger:CostLedger;
  constructor(repo:GovernanceRepository,clock:()=>number,ledger:CostLedger){this.repo=repo;this.clock=clock;this.ledger=ledger;}
  issue(input:Operation,expiresMs:number):string {
    const operation=normalizeOperation(input);money(expiresMs);
    return this.repo.atomic(()=>{
      const quote=this.ledger.quote(operation);
      if(expiresMs<=now(this.clock)||expiresMs>quote.expiresMs)throw new GovernanceError('invalid_approval_expiry');
      const token=randomBytes(32).toString('hex');
      const approval:Approval={id:capabilityId(token),taskId:operation.taskId,operationId:operation.id,version:1,bindingHash:operationHash(operation),expiresMs,status:'active'};
      this.repo.governancePut('approvals',approval,null);
      this.repo.appendGovernanceAudit({taskId:operation.taskId,operationId:operation.id,type:'approval_issued',atMs:now(this.clock)});return token;
    });
  }
  check(operation:Operation,token:string):Approval {
    const approval=this.repo.governanceGet('approvals',capabilityId(token));
    if(!approval||approval.bindingHash!==operationHash(operation)||approval.taskId!==operation.taskId||approval.operationId!==operation.id)throw new GovernanceError('approval_binding_mismatch');
    if(approval.status!=='active')throw new GovernanceError('approval_not_active');
    if(approval.expiresMs<=now(this.clock))throw new GovernanceError('approval_expired');return approval;
  }
  consume(approval:Approval):void {
    this.repo.governancePut('approvals',{...approval,version:approval.version+1,status:'consumed'},approval.version);
  }
  revoke(token:string):boolean {
    return this.repo.atomic(()=>{
      const approval=this.repo.governanceGet('approvals',capabilityId(token));if(!approval||approval.status!=='active')return false;
      this.repo.governancePut('approvals',{...approval,version:approval.version+1,status:'revoked'},approval.version);
      this.repo.appendGovernanceAudit({taskId:approval.taskId,operationId:approval.operationId,type:'approval_revoked',atMs:now(this.clock)});return true;
    });
  }
}
