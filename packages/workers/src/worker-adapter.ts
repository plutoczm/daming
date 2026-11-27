import type { ExecutorKind } from './descriptors.ts';
export interface SessionContext {sessionId:string;taskId:string;runId:string;attemptId:string;workspace:string;input:{text:string};}
export interface WorkerResult {
  mode:'fixture'|'real';sessionId:string;taskId:string;runId:string;attemptId:string;
  status:'completed'|'cancelled'|'timed_out'|'failed';output:string;events:readonly {type:string}[];
  /** Provider-reported token usage; absent when the executor could not report it. */
  usage?:Readonly<Record<string,number>>;
}
export interface SessionSnapshot {mode:'fixture'|'real';executorKind:ExecutorKind;context:SessionContext;active:boolean;result?:WorkerResult;}
export interface WorkerSession {
  createSession(context:SessionContext):void;
  run(sessionId:string,options?:{signal?:AbortSignal;timeoutMs?:number}):Promise<WorkerResult>;
  cancel(sessionId:string):void;
}
export function unavailableAdapter(executorKind:ExecutorKind) {
  return {executorKind,mode:'unavailable' as const,health:'unavailable' as const,reason:'Windows CLI/session protocol not yet verified; real execution requires Task 3 gates',nativeRoutePreserved:true};
}
