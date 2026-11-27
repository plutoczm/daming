import type { WorkerDescriptor, RoutingRequest } from './descriptors.ts';
import { routeWorkers } from './router.ts';
export class Registry {
  private readonly workers=new Map<string,WorkerDescriptor>();
  register(worker:WorkerDescriptor):void {
    if(!worker.id.trim()||this.workers.has(worker.id))throw new Error('Invalid or duplicate worker id');
    this.workers.set(worker.id,structuredClone(worker));
  }
  list():WorkerDescriptor[]{return structuredClone([...this.workers.values()]);}
  acquire(request:RoutingRequest):{worker:WorkerDescriptor;release:()=>void}|undefined {
    const selected=routeWorkers(this.list(),request).selected;if(!selected)return;
    const worker=this.workers.get(selected.id)!;worker.activeCount++;
    let released=false;
    return {worker:structuredClone(worker),release:()=>{if(!released){worker.activeCount--;released=true;}}};
  }
}
