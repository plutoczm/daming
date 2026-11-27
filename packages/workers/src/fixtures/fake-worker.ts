import type { ExecutorKind } from '../descriptors.ts';
import type { SessionContext,SessionSnapshot,WorkerResult } from '../worker-adapter.ts';
export class FixtureWorker {
  private readonly kind:ExecutorKind;
  private readonly options:{delayMs:number;fail:boolean};
  private readonly sessions=new Map<string,SessionSnapshot>();
  private readonly active=new Map<string,AbortController>();
  constructor(kind:ExecutorKind,options:{delayMs?:number;fail?:boolean}={}) {
    if(!['dsh','codex','claude-code'].includes(kind))throw new Error('Unknown executor');
    const delayMs=options.delayMs??0;if(!Number.isFinite(delayMs)||delayMs<0)throw new Error('Invalid delay');
    this.kind=kind;this.options={delayMs,fail:options.fail??false};
  }
  createSession(context:SessionContext):void {
    for(const key of ['sessionId','taskId','runId','attemptId','workspace'] as const)if(typeof context[key]!=='string'||!context[key].trim())throw new Error('Invalid session context');
    if(typeof context.input?.text!=='string'||this.sessions.has(context.sessionId))throw new Error('Invalid or duplicate session');
    this.sessions.set(context.sessionId,{mode:'fixture',executorKind:this.kind,context:structuredClone(context),active:false});
  }
  snapshot(id:string):SessionSnapshot {const session=this.sessions.get(id);if(!session)throw new Error('Unknown session');return structuredClone(session);}
  restore(snapshot:SessionSnapshot):void {
    if(snapshot.mode!=='fixture'||snapshot.executorKind!==this.kind||snapshot.active)throw new Error('Cannot restore this fixture snapshot');
    if(snapshot.result&&(snapshot.result.sessionId!==snapshot.context.sessionId||snapshot.result.taskId!==snapshot.context.taskId||snapshot.result.runId!==snapshot.context.runId||snapshot.result.attemptId!==snapshot.context.attemptId))throw new Error('Snapshot identity mismatch');
    this.createSession(snapshot.context);this.sessions.set(snapshot.context.sessionId,structuredClone(snapshot));
  }
  cancel(id:string):void {this.active.get(id)?.abort();}
  async run(id:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<WorkerResult> {
    const session=this.sessions.get(id);if(!session||this.active.has(id))throw new Error('Session missing or already running');
    const timeout=options.timeoutMs??1000;if(!Number.isFinite(timeout)||timeout<1)throw new Error('Invalid timeout');
    const controller=new AbortController();this.active.set(id,controller);session.active=true;
    return new Promise(resolve=>{
      let done=false;let work:ReturnType<typeof setTimeout>|undefined;let deadline:ReturnType<typeof setTimeout>|undefined;
      const finish=(status:WorkerResult['status'])=>{
        if(done)return;done=true;if(work)clearTimeout(work);if(deadline)clearTimeout(deadline);
        controller.signal.removeEventListener('abort',cancel);options.signal?.removeEventListener('abort',cancel);
        this.active.delete(id);session.active=false;
        const c=session.context;const result:WorkerResult={mode:'fixture',sessionId:c.sessionId,taskId:c.taskId,runId:c.runId,attemptId:c.attemptId,status,output:status==='completed'?c.input.text:'',events:[{type:'started'},{type:status}]};
        session.result=structuredClone(result);resolve(result);
      };
      const cancel=()=>finish('cancelled');controller.signal.addEventListener('abort',cancel,{once:true});options.signal?.addEventListener('abort',cancel,{once:true});
      if(options.signal?.aborted){cancel();return;}
      deadline=setTimeout(()=>finish('timed_out'),timeout);
      work=setTimeout(()=>finish(this.options.fail?'failed':'completed'),this.options.delayMs);
    });
  }
}
