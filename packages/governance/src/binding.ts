import { createHash } from 'node:crypto';
import { canonicalJson } from '@daming/core';
import type { Operation } from './model.ts';
import { GovernanceError } from './model.ts';
export function text(value:unknown):asserts value is string {if(typeof value!=='string'||!value.trim())throw new GovernanceError('invalid_text');}
export function money(value:unknown):asserts value is number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new GovernanceError('invalid_minor_amount');}
export function now(clock:()=>number):number {const value=clock();money(value);return value;}
export function add(a:number,b:number):number {const value=a+b;money(value);return value;}
export function subtract(a:number,b:number):number {const value=a-b;money(value);return value;}
function fields(value:object,allowed:string[]):void {if(Object.keys(value).some(key=>!allowed.includes(key)))throw new GovernanceError('unexpected_operation_fields');}
export function normalizeOperation(input:Operation):Operation {
  try {
    if(!input||typeof input!=='object')throw new GovernanceError('invalid_operation');
    const model=Object.hasOwn(input,'operationKind');
    fields(input,['id','taskId','runId','attemptId',model?'operationKind':'executorKind','toolId','toolVersion','target','payload','amountMinor','quoteId','route']);
    if(model&&input.operationKind!=='model_request')throw new GovernanceError('unknown_operation_kind');
    for(const name of ['id','taskId','runId','attemptId','toolId','toolVersion','target','quoteId'] as const)text(input[name]);
    if(!model&&(typeof input.executorKind!=='string'||!['fixture','dsh','codex','claude-code','local'].includes(input.executorKind)))throw new GovernanceError('unknown_executor');
    money(input.amountMinor);
    if(!input.route||typeof input.route!=='object')throw new GovernanceError('invalid_route');
    fields(input.route,['mode','provider','model','accountRef']);
    if(!['native','magpie'].includes(input.route.mode))throw new GovernanceError('invalid_route');
    for(const name of ['provider','model','accountRef'] as const)text(input.route[name]);
    if(!model&&input.executorKind==='local'&&(
      input.toolId!=='workflow.real'||input.toolVersion!=='1'||input.target!=='real'||
      input.route.mode!=='native'||input.route.provider!=='local'||
      input.route.model!=='none'||input.route.accountRef!=='local'
    ))throw new GovernanceError('local_executor_scope_invalid');
    return JSON.parse(canonicalJson(input)) as Operation;
  } catch(error) {if(error instanceof GovernanceError)throw error;throw new GovernanceError('invalid_operation');}
}
export function operationHash(operation:Operation):string {return createHash('sha256').update(canonicalJson(normalizeOperation(operation))).digest('hex');}
export function capabilityId(token:string):string {if(typeof token!=='string'||!token)throw new GovernanceError('approval_required');return createHash('sha256').update(token).digest('hex');}
export function freeze<T>(value:T):Readonly<T> {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
