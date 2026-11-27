import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodexProtocolAdapter } from '@daming/workers';
import type { CodexCorrelation,CodexProtocolEvent,CodexTrackedMethod } from '@daming/workers';

export class CodexProcessError extends Error {
  readonly code:string;readonly uncertain:boolean;
  constructor(code:string,uncertain=true){super(code);this.code=code;this.uncertain=uncertain;}
}
export interface CodexFixtureProcessOptions {
  context:CodexCorrelation;version:string;cwd:string;scenario?:string;
  requestTimeoutMs?:number;turnTimeoutMs?:number;cancelGraceMs?:number;closeGraceMs?:number;maxStderrBytes?:number;
}
export interface CodexProcessExit {
  mode:'fixture_process';exitCode:number|null;signal:string|null;uncertain:boolean;forced:boolean;
}
export interface CodexProcessTurn extends CodexCorrelation {
  mode:'fixture_process';threadId:string;turnId:string;
  status:'completed'|'interrupted'|'failed';output:string;uncertain:boolean;
}
interface Pending {
  method:CodexTrackedMethod;owner?:Active;
  resolve:(event:CodexProtocolEvent)=>void;reject:(error:CodexProcessError)=>void;
  timer:ReturnType<typeof setTimeout>;
}
interface Active {
  resolve:(result:CodexProcessTurn)=>void;reject:(error:CodexProcessError)=>void;
  timer:ReturnType<typeof setTimeout>;signal?:AbortSignal;abort:()=>void;
  messages:Map<string,string>;turnId?:string;cancelRequested:boolean;interruptSent:boolean;
  cancelTimer?:ReturnType<typeof setTimeout>;
}
const scenarios=['normal','silent','hang-turn','ignore-interrupt','malformed','partial-eof','exit-nonzero','approval-request','stderr-flood','env-check','ignore-eof','late-interrupt-error','lost-interrupt-reply'];
function limit(value:number|undefined,fallback:number):number {
  const result=value??fallback;if(!Number.isSafeInteger(result)||result<1||result>1024*1024)throw new CodexProcessError('invalid_limit',false);return result;
}
/** Only the owned mock executable can be launched. This is not a real Codex transport switch. */
export class CodexFixtureProcess {
  private readonly parser:CodexProtocolAdapter;
  private readonly options:Required<Omit<CodexFixtureProcessOptions,'context'>>;
  private readonly context:CodexCorrelation;
  private state:'new'|'starting'|'ready'|'closing'|'closed'='new';
  private child?:ChildProcessWithoutNullStreams;
  private sequence=0;
  private readonly pending=new Map<number,Pending>();
  private active?:Active;
  private threadId?:string;
  private bindingPending=false;
  private fault?:CodexProcessError;
  private hostClosedActive=false;
  private forced=false;
  private stderrBytes=0;
  private readonly history:CodexProtocolEvent[]=[];
  private historyBytes=0;
  private droppedEvents=0;
  private readonly listeners=new Set<(event:CodexProtocolEvent)=>void|Promise<void>>();
  private listenerErrors=0;
  private stopTimer?:ReturnType<typeof setTimeout>;
  private killTimer?:ReturnType<typeof setTimeout>;
  private readonly closedPromise:Promise<CodexProcessExit>;
  private resolveClosed!:(exit:CodexProcessExit)=>void;

  constructor(options:CodexFixtureProcessOptions) {
    const fields=['context','version','cwd','scenario','requestTimeoutMs','turnTimeoutMs','cancelGraceMs','closeGraceMs','maxStderrBytes'];
    if(Object.keys(options).some(key=>!fields.includes(key))||!scenarios.includes(options.scenario??'normal'))throw new CodexProcessError('fixture_only_configuration',false);
    if(!isAbsolute(options.cwd)||!statSync(options.cwd).isDirectory())throw new CodexProcessError('absolute_working_directory_required',false);
    this.context={taskId:options.context.taskId,runId:options.context.runId,attemptId:options.context.attemptId};
    this.parser=new CodexProtocolAdapter({version:options.version,context:this.context});
    this.options={version:options.version,cwd:options.cwd,scenario:options.scenario??'normal',requestTimeoutMs:limit(options.requestTimeoutMs,2000),turnTimeoutMs:limit(options.turnTimeoutMs,5000),cancelGraceMs:limit(options.cancelGraceMs,300),closeGraceMs:limit(options.closeGraceMs,200),maxStderrBytes:limit(options.maxStderrBytes,16384)};
    this.closedPromise=new Promise(resolve=>{this.resolveClosed=resolve;});
  }
  events():readonly CodexProtocolEvent[]{return structuredClone(this.history);}
  diagnostics(){return {mode:'fixture_process' as const,running:!!this.child&&this.state!=='closed',pid:this.child?.pid,stderrBytes:this.stderrBytes,rawStderrRetained:false,droppedEvents:this.droppedEvents,listenerErrors:this.listenerErrors};}
  onEvent(listener:(event:CodexProtocolEvent)=>void|Promise<void>):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private publish(event:CodexProtocolEvent):void {
    const size=Buffer.byteLength(JSON.stringify(event));
    if(size<=1024*1024) {
      this.history.push(structuredClone(event));this.historyBytes+=size;
      while(this.history.length>128||this.historyBytes>1024*1024){const old=this.history.shift()!;this.historyBytes-=Buffer.byteLength(JSON.stringify(old));this.droppedEvents++;}
    } else this.droppedEvents++;
    for(const listener of this.listeners) {
      try {Promise.resolve(listener(structuredClone(event))).catch(()=>{this.listenerErrors++;});}
      catch {this.listenerErrors++;}
    }
  }
  async start():Promise<void> {
    if(this.state!=='new')throw new CodexProcessError('process_already_started_or_closed',false);
    this.state='starting';
    const environment:NodeJS.ProcessEnv={};
    for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name]!==undefined)environment[name]=process.env[name];
    this.child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/mock-codex.mjs',import.meta.url)),this.options.scenario],{cwd:this.options.cwd,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.on('error',()=>this.stop(new CodexProcessError('spawn_error')));
    this.child.stdin.on('error',()=>{if(this.state!=='closing'&&this.state!=='closed')this.stop(new CodexProcessError('stdin_error'));});
    this.child.stdout.on('data',(chunk:Buffer)=>{
      if(this.state==='closed')return;
      try {for(const event of this.parser.push(chunk))this.accept(event);}
      catch {this.stop(new CodexProcessError('protocol_error'));}
    });
    this.child.stdout.on('end',()=>{if(this.state!=='closing'&&this.state!=='closed'&&(this.active||this.pending.size))this.stop(new CodexProcessError('stdout_closed'));});
    this.child.stderr.on('data',(chunk:Buffer)=>{this.stderrBytes+=chunk.length;if(this.stderrBytes>this.options.maxStderrBytes)this.stop(new CodexProcessError('stderr_limit'));});
    this.child.on('close',(code,signal)=>this.finish(code,signal));
    try {
      await this.request('initialize',{clientInfo:{name:'daming-offline-fixture',version:'0.0.0'}});
      if(this.state!=='starting')throw new CodexProcessError('handshake_cancelled',false);
      await this.write({method:'initialized'});
      if(this.state!=='starting')throw new CodexProcessError('handshake_cancelled',false);
      this.state='ready';
    } catch(error) {
      if(this.state==='starting'||this.state==='ready')this.stop(error instanceof CodexProcessError?error:new CodexProcessError('handshake_failed'));
      await this.closedPromise;throw error;
    }
  }
  private async write(frame:unknown):Promise<void> {
    if(!this.child||this.state==='closed'||this.state==='closing')throw new CodexProcessError('process_not_writable');
    const text=JSON.stringify(frame)+'\n';
    if(Buffer.byteLength(text)>65536)throw new CodexProcessError('outbound_frame_limit',false);
    await new Promise<void>((resolve,reject)=>{this.child!.stdin.write(text,error=>{if(error)reject(new CodexProcessError('stdin_error'));else resolve();});});
  }
  private request(method:CodexTrackedMethod,params:unknown,threadId?:string,turnId?:string):Promise<CodexProtocolEvent> {
    if(!this.child||this.state==='closed'||this.state==='closing')return Promise.reject(new CodexProcessError('process_not_writable'));
    if(this.pending.size>=32)return Promise.reject(new CodexProcessError('pending_limit',false));
    const id=this.sequence++;
    this.parser.expectResponse({id,method,...(threadId?{threadId}:{}),...(turnId?{turnId}:{})});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pending.has(id))this.stop(new CodexProcessError('request_timeout'));},this.options.requestTimeoutMs);
      this.pending.set(id,{resolve,reject,timer,method,...(method==='turn/interrupt'?{owner:this.active}:{})});
      void this.write({id,method,params}).catch(()=>this.stop(new CodexProcessError('write_failed')));
    });
  }
  private requireReady():void {if(this.state!=='ready')throw new CodexProcessError('process_not_ready',false);}
  private async bindThread(method:'thread/start'|'thread/resume',threadId?:string):Promise<CodexProtocolEvent> {
    this.requireReady();if(this.threadId||this.bindingPending)throw new CodexProcessError('thread_already_bound_or_pending',false);
    this.bindingPending=true;
    try {return await this.request(method,{cwd:this.options.cwd,...(threadId?{threadId}:{})},threadId);}
    finally {this.bindingPending=false;}
  }
  async createThread():Promise<CodexProtocolEvent> {return this.bindThread('thread/start');}
  async resumeThread(threadId:string):Promise<CodexProtocolEvent> {
    if(typeof threadId!=='string'||!threadId)throw new CodexProcessError('invalid_resume',false);
    return this.bindThread('thread/resume',threadId);
  }
  async startTurn(text:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<CodexProcessTurn> {
    this.requireReady();
    if(!this.threadId||this.active)throw new CodexProcessError('thread_missing_or_turn_active',false);
    if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>60000)throw new CodexProcessError('invalid_fixture_input',false);
    if(options.signal?.aborted)throw new CodexProcessError('aborted_before_send',false);
    const timeout=limit(options.timeoutMs,this.options.turnTimeoutMs);
    let resolve!:(result:CodexProcessTurn)=>void;let reject!:(error:CodexProcessError)=>void;
    const done=new Promise<CodexProcessTurn>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
    const abort=()=>this.cancel();
    const timer=setTimeout(()=>this.stop(new CodexProcessError('turn_timeout')),timeout);
    this.active={resolve,reject,timer,signal:options.signal,abort,messages:new Map(),cancelRequested:false,interruptSent:false};
    options.signal?.addEventListener('abort',abort,{once:true});
    void this.request('turn/start',{threadId:this.threadId,input:[{type:'text',text}]},this.threadId).catch(()=>this.stop(new CodexProcessError('turn_request_failed')));
    return done;
  }
  cancel():void {
    const active=this.active;if(!active||active.cancelRequested)return;
    active.cancelRequested=true;
    active.cancelTimer=setTimeout(()=>this.stop(new CodexProcessError('cancel_timeout')),this.options.cancelGraceMs);
    this.sendInterrupt();
  }
  private sendInterrupt():void {
    const active=this.active;
    if(!active||!active.cancelRequested||active.interruptSent||!active.turnId||this.state!=='ready')return;
    active.interruptSent=true;
    void this.request('turn/interrupt',{threadId:this.threadId,turnId:active.turnId},this.threadId,active.turnId).catch(()=>{if(this.active===active)this.stop(new CodexProcessError('interrupt_request_failed'));});
  }
  private clearActive(retireInterrupts=false):Active|undefined {
    const active=this.active;if(!active)return;
    clearTimeout(active.timer);if(active.cancelTimer)clearTimeout(active.cancelTimer);
    active.signal?.removeEventListener('abort',active.abort);this.active=undefined;
    if(retireInterrupts)for(const [id,pending] of this.pending)if(pending.method==='turn/interrupt'&&pending.owner===active) {
      clearTimeout(pending.timer);this.pending.delete(id);this.parser.retireInterruptResponse(id);
      pending.reject(new CodexProcessError('interrupt_retired_after_terminal',false));
    }
    return active;
  }
  private accept(event:CodexProtocolEvent):void {
    const pending=typeof event.requestId==='number'?this.pending.get(event.requestId):undefined;
    if(pending&&['initialized','thread_bound','turn_bound','interrupt_ack','rpc_error'].includes(event.kind)) {
      clearTimeout(pending.timer);this.pending.delete(event.requestId as number);
      if(event.kind==='rpc_error')pending.reject(new CodexProcessError('rpc_error'));
      else pending.resolve(event);
    }
    if(event.kind==='thread_bound')this.threadId=event.threadId;
    if(event.kind==='turn_bound'&&this.active){this.active.turnId=event.turnId;this.sendInterrupt();}
    const active=this.active;
    if(active&&event.turnId===active.turnId&&(event.kind==='text_delta'||event.kind==='message_completed')) {
      const id=event.itemId!;
      const text=event.kind==='text_delta'?(active.messages.get(id)??'')+(event.text??''):(event.text??'');
      active.messages.set(id,text);
      if(active.messages.size>128||[...active.messages.values()].reduce((n,value)=>n+Buffer.byteLength(value),0)>1024*1024){this.stop(new CodexProcessError('output_limit'));return;}
    }
    if(active&&event.kind==='turn_completed'&&typeof event.turnId==='string'&&event.turnId===active.turnId&&!this.fault&&!this.hostClosedActive) {
      const result=this.clearActive(true)!;
      result.resolve({mode:'fixture_process',...this.context,threadId:event.threadId!,turnId:event.turnId,status:event.status!,output:[...result.messages.values()].join('\n'),uncertain:event.uncertain??true});
    }
    this.publish(event);
    if(event.kind==='request_blocked')this.stop(new CodexProcessError('approval_or_server_request_blocked'));
  }
  private stop(error:CodexProcessError):void {
    if(this.state==='closed')return;
    this.fault??=error;this.state='closing';
    this.child?.stdin.destroy();
    this.terminate();
  }
  private terminate():void {
    if(!this.child)return;
    this.forced=true;this.child.kill('SIGTERM');
    if(!this.killTimer)this.killTimer=setTimeout(()=>this.child?.kill('SIGKILL'),this.options.closeGraceMs);
  }
  close():Promise<CodexProcessExit> {
    if(this.state==='new'){this.state='closing';this.finish(null,null);return this.closedPromise;}
    if(this.state==='closed'||this.state==='closing')return this.closedPromise;
    this.hostClosedActive=!!this.active;this.state='closing';
    this.child?.stdin.end();
    this.stopTimer=setTimeout(()=>this.terminate(),this.options.closeGraceMs);
    return this.closedPromise;
  }
  private finish(exitCode:number|null,signal:string|null):void {
    if(this.state==='closed')return;
    this.state='closed';
    if(this.stopTimer)clearTimeout(this.stopTimer);if(this.killTimer)clearTimeout(this.killTimer);
    if(exitCode!==null&&exitCode!==0)this.fault??=new CodexProcessError('nonzero_exit');
    const events=this.parser.finish();
    const closed=events.find(event=>event.kind==='transport_closed');
    const uncertain=!!closed?.uncertain||!!this.fault?.uncertain||this.hostClosedActive||this.forced;
    for(const event of events) {
      if(event.kind==='transport_closed')this.publish({...event,uncertain});
      else this.accept(event);
    }
    const error=this.fault??new CodexProcessError('process_closed',uncertain);
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
    this.clearActive()?.reject(error);
    this.resolveClosed({mode:'fixture_process',exitCode,signal,uncertain,forced:this.forced});
  }
}
