import { CodexJsonLines, CodexProtocolError } from './codex-framing.ts';
export { CodexProtocolError } from './codex-framing.ts';
export type CodexRequestId=string|number;
export type CodexTrackedMethod='initialize'|'thread/start'|'thread/resume'|'turn/start'|'turn/interrupt';
export interface CodexCorrelation {readonly taskId:string;readonly runId:string;readonly attemptId:string;}
export interface CodexExpectedResponse {readonly id:CodexRequestId;readonly method:CodexTrackedMethod;readonly threadId?:string;readonly turnId?:string;}
export interface CodexProtocolEvent extends CodexCorrelation {
  readonly kind:'initialized'|'thread_bound'|'turn_bound'|'turn_started'|'text_delta'|'message_completed'|'item_started'|'item_completed'|'turn_completed'|'rpc_error'|'interrupt_ack'|'request_blocked'|'workspace_read_requested'|'warning'|'transport_closed';
  readonly threadId?:string;readonly turnId?:string;readonly itemId?:string;readonly requestId?:CodexRequestId;
  readonly text?:string;readonly status?:'completed'|'interrupted'|'failed';readonly code?:number|string;
  readonly willRetry?:boolean;readonly uncertain?:boolean;readonly itemType?:string;readonly exitCode?:number|null;
  readonly callId?:string;readonly workspaceFile?:string;
}
export interface CodexProtocolOptions {
  readonly version:string;readonly context:CodexCorrelation;
  readonly binding?:{readonly threadId:string;readonly turnId?:string};readonly maxFrameBytes?:number;
  readonly allowWorkspaceRead?:boolean;
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CodexProtocolError('Expected protocol object');
  return value as Record<string,unknown>;
}
function string(value:unknown):string {if(typeof value!=='string'||!value.length)throw new CodexProtocolError('Missing protocol identifier');return value;}
function requestId(value:unknown):CodexRequestId {
  if(typeof value==='string'&&value.length)return value;
  if(typeof value==='number'&&Number.isSafeInteger(value))return value;
  throw new CodexProtocolError('Invalid request id');
}
const key=(id:CodexRequestId)=>typeof id+':'+id;
const methods:readonly string[]=['initialize','thread/start','thread/resume','turn/start','turn/interrupt'];
function turn(value:unknown):{id:string;status:string} {
  const t=object(value);const id=string(t.id);
  if(!['inProgress','completed','interrupted','failed'].includes(t.status as string)||!Array.isArray(t.items))throw new CodexProtocolError('Invalid turn projection');
  return {id,status:t.status as string};
}
/** Offline App Server projection only: no process launch, outgoing RPC or Task writes. */
export class CodexProtocolAdapter {
  private readonly context:CodexCorrelation;
  private readonly framing:CodexJsonLines;
  private readonly allowWorkspaceRead:boolean;
  private readonly pending=new Map<string,CodexExpectedResponse>();
  private threadId?:string;
  private turnId?:string;
  private terminal?:'completed'|'interrupted'|'failed';
  private broken=false;
  private closed=false;
  constructor(options:CodexProtocolOptions) {
    if(!['0.159.2','0.167.0-alpha.3.2','0.169.0'].includes(options.version))throw new CodexProtocolError('Codex version has not been inspected');
    for(const name of ['taskId','runId','attemptId'] as const)string(options.context[name]);
    this.context=Object.freeze({taskId:options.context.taskId,runId:options.context.runId,attemptId:options.context.attemptId});this.framing=new CodexJsonLines(options.maxFrameBytes??1024*1024);
    this.allowWorkspaceRead=options.allowWorkspaceRead===true;
    if(options.binding) {this.threadId=string(options.binding.threadId);if(options.binding.turnId!==undefined)this.turnId=string(options.binding.turnId);}
  }
  private event(kind:CodexProtocolEvent['kind'],fields:Omit<Partial<CodexProtocolEvent>,'taskId'|'runId'|'attemptId'|'kind'>={}):CodexProtocolEvent {
    return {...this.context,kind,...(this.threadId?{threadId:this.threadId}:{}),...(this.turnId?{turnId:this.turnId}:{}),...fields};
  }
  private replyEvent(kind:CodexProtocolEvent['kind'],expected:CodexExpectedResponse,fields:Partial<CodexProtocolEvent>={}):CodexProtocolEvent {
    // Replies retain request-time scope; current turn state may have advanced.
    return {...this.context,kind,requestId:expected.id,...(expected.threadId?{threadId:expected.threadId}:{}),...(expected.turnId?{turnId:expected.turnId}:{}),...fields};
  }
  expectResponse(expected:CodexExpectedResponse):void {
    if(this.closed||this.broken)throw new CodexProtocolError('Protocol stream is not open');
    requestId(expected.id);
    if(!methods.includes(expected.method)||this.pending.has(key(expected.id))||this.pending.size>=256)throw new CodexProtocolError('Unsupported or duplicate pending request');
    const threadId=expected.method==='initialize'?undefined:expected.threadId??this.threadId;
    if(['thread/resume','turn/start','turn/interrupt'].includes(expected.method)&&!threadId)throw new CodexProtocolError('Expected thread correlation');
    if(threadId&&this.threadId&&threadId!==this.threadId)throw new CodexProtocolError('Thread correlation cannot change');
    if(expected.method==='turn/interrupt'&&(!expected.turnId||expected.turnId!==this.turnId))throw new CodexProtocolError('Expected active turn correlation');
    this.pending.set(key(expected.id),{id:expected.id,method:expected.method,...(threadId?{threadId}:{}),...(expected.turnId?{turnId:expected.turnId}:{})});
  }
  retireInterruptResponse(id:CodexRequestId):void {
    const pending=this.pending.get(key(requestId(id)));if(!pending)return;
    if(pending.method!=='turn/interrupt'||!this.terminal||pending.threadId!==this.threadId||pending.turnId!==this.turnId)throw new CodexProtocolError('Only a known terminal interrupt can be retired');
    this.pending.delete(key(id));
  }
  push(chunk:Uint8Array):CodexProtocolEvent[] {
    if(this.closed||this.broken)throw new CodexProtocolError('Protocol stream is not open');
    try {return this.framing.push(chunk).flatMap(frame=>this.frame(frame));}
    catch {this.broken=true;throw new CodexProtocolError('Invalid Codex protocol stream');}
  }
  finish():CodexProtocolEvent[] {
    if(this.closed)return [];
    const events:CodexProtocolEvent[]=[];
    if(!this.broken) {
      try {for(const frame of this.framing.finish())events.push(...this.frame(frame));}
      catch {this.broken=true;events.push(this.event('warning',{code:'protocol_error'}));}
    }
    const uncertain=this.broken||!!(this.turnId&&!this.terminal)||this.pending.size>0;
    events.push(this.event('transport_closed',{uncertain}));
    this.closed=true;this.pending.clear();return events;
  }
  private frame(value:unknown):CodexProtocolEvent[] {
    const message=object(value);
    if(message.jsonrpc!==undefined&&message.jsonrpc!=='2.0')throw new CodexProtocolError('Unsupported RPC envelope');
    if(message.method!==undefined) {
      if(typeof message.method!=='string'||Object.hasOwn(message,'result')||Object.hasOwn(message,'error'))throw new CodexProtocolError('Invalid request/notification');
      if(Object.hasOwn(message,'id')) {
        const id=requestId(message.id);const params=message.params===undefined?{}:object(message.params);
        if(params.threadId!==undefined&&params.threadId!==this.threadId)return [];
        if(params.turnId!==undefined&&params.turnId!==this.turnId)return [];
        if (this.allowWorkspaceRead && message.method === 'item/tool/call' && params.tool === 'project_read_file' &&
            params.namespace == null && this.threadId && this.turnId && !this.terminal &&
            params.threadId === this.threadId && params.turnId === this.turnId) {
          const args = object(params.arguments);
          const callId = string(params.callId), workspaceFile = string(args.file);
          if (Object.keys(args).length !== 1 || callId.length > 160 || workspaceFile.length > 200) {
            throw new CodexProtocolError('Invalid workspace read request');
          }
          return [this.event('workspace_read_requested', { requestId: id, callId, workspaceFile })];
        }
        // An event is not an approval. No reply writer exists in this adapter.
        return [this.event('request_blocked',{requestId:id,code:params.threadId===undefined?'unscoped_request':'approval_not_implemented'})];
      }
      return this.notification(message.method,message.params);
    }
    const id=requestId(message.id);const expected=this.pending.get(key(id));if(!expected)return [];
    if(Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw new CodexProtocolError('Invalid RPC reply');
    this.pending.delete(key(id));
    if(Object.hasOwn(message,'error')) {
      const error=object(message.error);
      if(!Number.isSafeInteger(error.code)||typeof error.message!=='string')throw new CodexProtocolError('Invalid RPC error');
      return [this.replyEvent('rpc_error',expected,{code:error.code as number})];
    }
    const result=object(message.result);
    if(expected.method==='initialize')return [this.replyEvent('initialized',expected)];
    if(expected.method==='thread/start'||expected.method==='thread/resume') {
      const threadId=string(object(result.thread).id);
      if((expected.threadId&&expected.threadId!==threadId)||(this.threadId&&this.threadId!==threadId))throw new CodexProtocolError('Reply thread mismatch');
      this.threadId=threadId;return [this.replyEvent('thread_bound',expected,{threadId})];
    }
    if(expected.method==='turn/interrupt')return [this.replyEvent('interrupt_ack',expected)];
    if(this.threadId&&expected.threadId!==this.threadId)throw new CodexProtocolError('Reply thread mismatch');
    const parsed=turn(result.turn);
    if(this.turnId&&(!this.terminal&&this.turnId!==parsed.id||this.terminal&&this.turnId===parsed.id))throw new CodexProtocolError('Reply turn mismatch or reused terminal turn');
    this.threadId=expected.threadId;this.turnId=parsed.id;this.terminal=undefined;
    return [this.replyEvent('turn_bound',expected,{threadId:this.threadId,turnId:this.turnId})];
  }
  private notification(method:string,value:unknown):CodexProtocolEvent[] {
    const supported=['thread/started','turn/started','turn/completed','item/agentMessage/delta','item/started','item/completed','error'];
    if(!supported.includes(method))return [];
    const params=object(value);
    if(method==='thread/started') {string(object(params.thread).id);return [];}
    if(string(params.threadId)!==this.threadId)return [];
    if(method==='turn/started'||method==='turn/completed') {
      const parsed=turn(params.turn);if(parsed.id!==this.turnId)return [];
      if(method==='turn/started') {if(parsed.status!=='inProgress')throw new CodexProtocolError('Invalid turn start');return this.terminal?[]:[this.event('turn_started')];}
      if(parsed.status==='inProgress')throw new CodexProtocolError('Nonterminal turn completion');
      const status=parsed.status as 'completed'|'failed'|'interrupted';
      if(this.terminal) {if(this.terminal!==status)throw new CodexProtocolError('Conflicting terminal report');return [];}
      this.terminal=status;return [this.event('turn_completed',{status,uncertain:status!=='completed'})];
    }
    if(string(params.turnId)!==this.turnId||this.terminal)return [];
    if(method==='error') {
      object(params.error);if(typeof params.willRetry!=='boolean')throw new CodexProtocolError('Invalid error projection');
      return [this.event('warning',{code:'codex_error',willRetry:params.willRetry})];
    }
    if(method==='item/agentMessage/delta') {
      const itemId=string(params.itemId);if(typeof params.delta!=='string')throw new CodexProtocolError('Invalid text delta');
      return [this.event('text_delta',{itemId,text:params.delta})];
    }
    const item=object(params.item);const itemId=string(item.id);const type=string(item.type);
    const itemType=['agentMessage','commandExecution','fileChange','mcpToolCall','reasoning','plan','webSearch','imageView'].includes(type)?type:'other';
    if(method==='item/completed'&&itemType==='agentMessage') {
      if(typeof item.text!=='string')throw new CodexProtocolError('Invalid final message');
      return [this.event('message_completed',{itemId,itemType,text:item.text})];
    }
    let fields:Partial<CodexProtocolEvent>={itemId,itemType};
    if(itemType==='commandExecution'&&item.exitCode!==undefined) {
      if(item.exitCode!==null&&!Number.isSafeInteger(item.exitCode))throw new CodexProtocolError('Invalid command exit code');
      fields={...fields,exitCode:item.exitCode as number|null};
    }
    return [this.event(method==='item/started'?'item_started':'item_completed',fields)];
  }
}
