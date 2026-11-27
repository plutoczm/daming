import type { TaskState } from './model.ts';
import { DomainError } from './errors.ts';
const transitions:Record<TaskState,readonly TaskState[]>={
  draft:['planned','cancelled'],
  planned:['awaiting_approval','queued','blocked','failed','cancelled'],
  awaiting_approval:['queued','blocked','failed','cancelled'],
  queued:['running','blocked','failed','cancelled'],
  running:['reviewing','blocked','failed','cancelled'],
  reviewing:['running','completed','blocked','failed','cancelled'],
  blocked:['planned','awaiting_approval','queued','failed','cancelled'],
  completed:[],failed:[],cancelled:[],
};
export function assertTransition(from:TaskState,to:TaskState):void {
  if(!transitions[from]?.includes(to)) throw new DomainError('Illegal task transition: '+from+' -> '+to);
}
