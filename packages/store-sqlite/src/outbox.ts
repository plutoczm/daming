import { canonicalJson, DomainError } from '@daming/core';
import type { Engine, EffectOutcome, OutboxEffect } from '@daming/core';
import type { EffectExecutor } from '@daming/ports';
import type { SqliteStore } from './store.ts';

/** Dispatch requires an explicitly supplied executor; no real tool adapters are installed here. */
export class Outbox {
  private readonly store:SqliteStore;
  private readonly engine:Engine;
  private readonly now:()=>string;
  constructor(store:SqliteStore,engine:Engine,now:()=>string) { this.store=store;this.engine=engine;this.now=now; }
  /** Cold-start only: the host must first ensure old dispatchers have stopped. */
  recoverInterrupted():void {
    for(const effect of this.store.executingEffects()) {
      this.engine.settleEffect(effect.effectId,effect.attempts,{status:'unknown',reason:'Host interrupted before a durable receipt'},this.now());
    }
  }
  async dispatchOne(execute:EffectExecutor,taskId?:string):Promise<OutboxEffect|undefined> {
    const effect=this.store.claimNext(this.now(),taskId);
    if(!effect)return;
    let outcome:EffectOutcome;
    try {
      const candidate=JSON.parse(canonicalJson(await execute(JSON.parse(canonicalJson(effect)) as OutboxEffect))) as EffectOutcome;
      if(!candidate||!['succeeded','not_executed','unknown'].includes(candidate.status)) throw new DomainError('Invalid executor receipt');
      if(candidate.status==='succeeded') {
        if(!Object.hasOwn(candidate,'result')) throw new DomainError('Missing executor result');
      } else {
        if(typeof candidate.reason!=='string'||!candidate.reason.trim()) throw new DomainError('Missing executor reason');
        if(candidate.status==='not_executed'&&typeof candidate.retryable!=='boolean') throw new DomainError('Invalid executor retry flag');
      }
      outcome=candidate;
    } catch(error) {
      outcome={status:'unknown',reason:'Executor did not provide a reliable receipt: '+(error instanceof Error?error.message:String(error))};
    }
    this.engine.settleEffect(effect.effectId,effect.attempts,outcome,this.now());
    return this.store.getEffect(effect.effectId);
  }
}
