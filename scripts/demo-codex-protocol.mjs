import { CodexProtocolAdapter } from '../packages/workers/src/index.ts';
const parser=new CodexProtocolAdapter({version:'0.167.0-alpha.3.2',context:{taskId:'fixture-task',runId:'fixture-run',attemptId:'fixture-attempt'}});
const encode=value=>new TextEncoder().encode(JSON.stringify(value)+'\n');
const events=[];
parser.expectResponse({id:0,method:'thread/start'});
events.push(...parser.push(encode({id:0,result:{thread:{id:'fixture-thread'}}})));
parser.expectResponse({id:1,method:'turn/start',threadId:'fixture-thread'});
events.push(...parser.push(encode({id:1,result:{turn:{id:'fixture-turn',status:'inProgress',items:[]}}})));
for(const frame of [
  {method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId:'fixture-turn',itemId:'message',delta:'Synthetic output'}},
  {method:'item/completed',params:{threadId:'fixture-thread',turnId:'fixture-turn',completedAtMs:0,item:{id:'message',type:'agentMessage',text:'Synthetic output'}}},
  {method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[]}}}
])events.push(...parser.push(encode(frame)));
events.push(...parser.finish());
console.log(JSON.stringify({mode:'offline_protocol_fixture',events,modelRequests:0},null,2));
