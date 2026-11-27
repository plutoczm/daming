// Owned offline fixture: no network, filesystem writes, eval, or descendant processes.
import { createInterface } from 'node:readline';
const scenario=process.argv[2]??'normal';
let initialized=false;let sequence=0;let current;let work;
const hold=setInterval(()=>{},1000);
if(scenario==='ignore-eof')process.on('SIGTERM',()=>{});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const reply=(id,result)=>send({id,result});
const error=(id,code)=>send({id,error:{code,message:'fixture rejection'}});
const terminal=status=>{
  if(!current)return;clearTimeout(work);
  send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:current,status,items:[]}}});current=undefined;
};
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  const message=JSON.parse(line);
  if(message.method==='initialize') {if(scenario!=='silent')reply(message.id,{userAgent:'daming-offline-fixture'});return;}
  if(message.method==='initialized') {initialized=true;return;}
  if(!initialized){error(message.id,-32002);return;}
  if(message.method==='thread/start'){reply(message.id,{thread:{id:'fixture-thread'}});return;}
  if(message.method==='thread/resume'){
    if(message.params.threadId!=='fixture-thread')error(message.id,-32001);
    else reply(message.id,{thread:{id:'fixture-thread'}});
    return;
  }
  if(message.method==='turn/interrupt'){
    if(scenario==='lost-interrupt-reply'){terminal('interrupted');return;}
    if(scenario==='late-interrupt-error'){terminal('interrupted');setTimeout(()=>error(message.id,-32000),40);return;}
    reply(message.id,{});
    if(scenario!=='ignore-interrupt')setTimeout(()=>terminal('interrupted'),5);
    return;
  }
  if(message.method!=='turn/start'){error(message.id,-32601);return;}
  if(current){error(message.id,-32003);return;}
  current='fixture-turn-'+(++sequence);
  reply(message.id,{turn:{id:current,status:'inProgress',items:[]}});
  if(scenario==='malformed'){process.stdout.write('malformed fixture line\n');return;}
  if(scenario==='partial-eof'){process.stdout.write('{"method":');process.exit(0);}
  if(scenario==='exit-nonzero'){process.stderr.write('fixture-secret');process.exit(7);}
  if(scenario==='stderr-flood'){process.stderr.write('fixture-secret'.repeat(6000));return;}
  if(scenario==='approval-request'){
    send({id:'fixture-approval',method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:current,command:'private fixture command'}});
    return;
  }
  if(['hang-turn','ignore-interrupt'].includes(scenario)||(['late-interrupt-error','lost-interrupt-reply'].includes(scenario)&&sequence===1))return;
  const output=scenario==='env-check'?(process.env.DAMING_TEST_SECRET===undefined?'isolated_environment':'leaked_environment'):message.params.input[0].text;
  work=setTimeout(()=>{
    if(!current)return;
    send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId:current,itemId:'message',delta:output}});
    send({method:'item/completed',params:{threadId:'fixture-thread',turnId:current,completedAtMs:0,item:{id:'message',type:'agentMessage',text:output}}});
    terminal('completed');
  },scenario==='lost-interrupt-reply'?450:scenario==='late-interrupt-error'?100:20);
});
input.on('close',()=>{if(scenario!=='ignore-eof'){clearInterval(hold);clearTimeout(work);process.exit(0);}});
