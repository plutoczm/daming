import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexProtocolAdapter, CodexProtocolError } from '../src/adapters/codex-protocol.ts';
const context={taskId:'task',runId:'run',attemptId:'attempt'};
const version='0.167.0-alpha.3.2' as const;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)+'\n');
const notification=(method:string,params:unknown)=>({method,params});
const turn=(id='turn',status='completed')=>({id,status,items:[]});
function bound(){return new CodexProtocolAdapter({version,context,binding:{threadId:'thread',turnId:'turn'}});}
test('known versions are explicit and unsupported versions do not silently downgrade',()=>{
  for(const v of ['0.159.2',version]) assert.ok(new CodexProtocolAdapter({version:v,context}));
  assert.throws(()=>new CodexProtocolAdapter({version:'latest',context}),CodexProtocolError);
});
test('UTF-8 text split at every byte and CRLF preserves task identity',()=>{
  const adapter=bound();const input=new TextEncoder().encode(JSON.stringify(notification('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'i',delta:'大铭🙂'}))+'\r\n');
  const output=[];for(const byte of input)output.push(...adapter.push(new Uint8Array([byte])));
  assert.equal(output.length,1);assert.equal(output[0].text,'大铭🙂');assert.equal(output[0].attemptId,'attempt');
});
test('reply correlation accepts id zero and binds thread/turn only from matching replies',()=>{
  const adapter=new CodexProtocolAdapter({version,context});
  adapter.expectResponse({id:0,method:'thread/start'});
  assert.deepEqual(adapter.push(bytes({id:9,result:{thread:{id:'foreign'}}})),[]);
  assert.equal(adapter.push(bytes({id:0,result:{thread:{id:'thread'}}}))[0].kind,'thread_bound');
  adapter.expectResponse({id:'turn-start',method:'turn/start',threadId:'thread'});
  assert.equal(adapter.push(bytes({id:'turn-start',result:{turn:turn('turn','inProgress')}}))[0].kind,'turn_bound');
  assert.equal(adapter.push(bytes(notification('turn/completed',{threadId:'thread',turn:turn()})))[0].status,'completed');
  assert.equal(adapter.finish().at(-1)?.uncertain,false);
});
test('foreign thread/turn events are ignored and cannot complete this attempt',()=>{
  const adapter=bound();
  for(const params of [{threadId:'other',turn:turn()},{threadId:'thread',turn:turn('other')}]) assert.deepEqual(adapter.push(bytes(notification('turn/completed',params))),[]);
  assert.equal(adapter.finish().at(-1)?.uncertain,true);
});
test('terminal duplicates do not produce duplicate completion',()=>{
  const adapter=bound();const message=bytes(notification('turn/completed',{threadId:'thread',turn:turn()}));
  assert.equal(adapter.push(message).length,1);assert.deepEqual(adapter.push(message),[]);
});
test('interrupt success is an acknowledgement and not proof that the turn ended',()=>{
  const adapter=bound();adapter.expectResponse({id:1,method:'turn/interrupt',threadId:'thread',turnId:'turn'});
  assert.equal(adapter.push(bytes({id:1,result:{}}))[0].kind,'interrupt_ack');
  assert.equal(adapter.finish().at(-1)?.uncertain,true);
});
test('retryable error notifications do not fabricate a failed or completed turn',()=>{
  const adapter=bound();const events=adapter.push(bytes(notification('error',{threadId:'thread',turnId:'turn',willRetry:true,error:{message:'private diagnostic'}})));
  assert.equal(events[0].kind,'warning');assert.equal(events[0].willRetry,true);
  assert.equal(JSON.stringify(events).includes('private diagnostic'),false);
  assert.equal(adapter.finish().at(-1)?.uncertain,true);
});
test('approvals and unknown server requests never become automatic tool permission',()=>{
  const adapter=bound();const events=adapter.push(bytes({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'secret command'}}));
  assert.equal(events[0].kind,'request_blocked');assert.equal(events[0].requestId,'approval');
  assert.equal(JSON.stringify(events).includes('secret command'),false);
});
test('malformed JSON, invalid UTF-8 and frame overflow poison the stream',()=>{
  for(const input of [new TextEncoder().encode('{bad}\n'),new Uint8Array([255,10]),new TextEncoder().encode('x'.repeat(33))]) {
    const adapter=new CodexProtocolAdapter({version,context,binding:{threadId:'thread',turnId:'turn'},maxFrameBytes:32});
    assert.throws(()=>adapter.push(input),CodexProtocolError);
    assert.throws(()=>adapter.push(bytes({})),CodexProtocolError);
    assert.equal(adapter.finish().at(-1)?.uncertain,true);
  }
});
test('invalid or conflicting terminal states cannot be interpreted as success',()=>{
  const adapter=bound();assert.throws(()=>adapter.push(bytes(notification('turn/completed',{threadId:'thread',turn:turn('turn','inProgress')}))),CodexProtocolError);
  assert.equal(adapter.finish().at(-1)?.uncertain,true);
});
test('unknown notifications are ignored and exec JSONL cannot be mistaken for App Server',()=>{
  const adapter=bound();assert.deepEqual(adapter.push(bytes({method:'future/update',params:{anything:'private'}})),[]);
  assert.throws(()=>adapter.push(bytes({type:'thread.started',thread_id:'x'})),CodexProtocolError);
});
test('resumed reply must match the explicitly expected thread',()=>{
  const adapter=new CodexProtocolAdapter({version,context});adapter.expectResponse({id:1,method:'thread/resume',threadId:'expected'});
  assert.throws(()=>adapter.push(bytes({id:1,result:{thread:{id:'wrong'}}})),CodexProtocolError);
});
test('RPC errors retain code and correlation without forwarding private payloads',()=>{
  const adapter=new CodexProtocolAdapter({version,context});adapter.expectResponse({id:1,method:'thread/start'});
  const events=adapter.push(bytes({id:1,error:{code:-32000,message:'private key',data:{secret:'hidden'}}}));
  assert.equal(events[0].kind,'rpc_error');assert.equal(events[0].code,-32000);assert.equal(JSON.stringify(events).includes('private key'),false);
});
test('last JSONL frame without newline is parsed, and finish is idempotent',()=>{
  const adapter=bound();adapter.push(new TextEncoder().encode(JSON.stringify(notification('turn/completed',{threadId:'thread',turn:turn()}))));
  const events=adapter.finish();assert.equal(events[0].kind,'turn_completed');assert.equal(events.at(-1)?.uncertain,false);assert.deepEqual(adapter.finish(),[]);
});

test('caller context extension fields cannot leak into normalized events',()=>{
  const adapter=new CodexProtocolAdapter({version,context:{...context,apiKey:'private'} as never,binding:{threadId:'thread',turnId:'turn'}});
  const events=adapter.push(bytes(notification('turn/completed',{threadId:'thread',turn:turn()})));
  assert.equal(JSON.stringify(events).includes('private'),false);
});
test('an out-of-order turn reply cannot retarget an already bound thread',()=>{
  const adapter=new CodexProtocolAdapter({version,context});
  adapter.expectResponse({id:1,method:'thread/start'});adapter.expectResponse({id:2,method:'turn/start',threadId:'A'});
  adapter.push(bytes({id:1,result:{thread:{id:'B'}}}));
  assert.throws(()=>adapter.push(bytes({id:2,result:{turn:turn('turn','inProgress')}})),CodexProtocolError);
});

test('delayed interrupt replies retain the original turn for success and error',()=>{
  for(const failed of [false,true]) {
    const adapter=new CodexProtocolAdapter({version,context,binding:{threadId:'thread',turnId:'old'}});
    adapter.expectResponse({id:1,method:'turn/interrupt',threadId:'thread',turnId:'old'});
    adapter.push(bytes(notification('turn/completed',{threadId:'thread',turn:turn('old')})));
    adapter.expectResponse({id:2,method:'turn/start',threadId:'thread'});
    adapter.push(bytes({id:2,result:{turn:turn('new','inProgress')}}));
    const reply=failed?{id:1,error:{code:-1,message:'old turn error'}}:{id:1,result:{}};
    assert.equal(adapter.push(bytes(reply))[0].turnId,'old');
  }
});
test('startup and thread replies never acquire an unrelated current turn',()=>{
  const adapter=new CodexProtocolAdapter({version,context});
  adapter.expectResponse({id:0,method:'initialize'});
  adapter.expectResponse({id:1,method:'thread/start'});adapter.push(bytes({id:1,result:{thread:{id:'thread'}}}));
  adapter.expectResponse({id:2,method:'thread/resume',threadId:'thread'});
  adapter.expectResponse({id:3,method:'turn/start',threadId:'thread'});adapter.push(bytes({id:3,result:{turn:turn('new','inProgress')}}));
  const initialized=adapter.push(bytes({id:0,result:{userAgent:'fixture'}}))[0];
  assert.equal(initialized.turnId,undefined);assert.equal(initialized.threadId,undefined);
  assert.equal(adapter.push(bytes({id:2,result:{thread:{id:'thread'}}}))[0].turnId,undefined);
});

test('tool completion preserves nonzero exit code and final text is a separate replacement event',()=>{
  const adapter=bound();
  const item=adapter.push(bytes(notification('item/completed',{threadId:'thread',turnId:'turn',completedAtMs:0,item:{id:'tool',type:'commandExecution',exitCode:2,command:'private',aggregatedOutput:'private'}})))[0];
  assert.equal(item.kind,'item_completed');assert.equal(item.exitCode,2);assert.equal(item.status,undefined);assert.equal(JSON.stringify(item).includes('private'),false);
  const message=adapter.push(bytes(notification('item/completed',{threadId:'thread',turnId:'turn',completedAtMs:0,item:{id:'message',type:'agentMessage',text:'final'}})))[0];
  assert.equal(message.kind,'message_completed');assert.equal(message.text,'final');
});
test('truncated final JSON reports uncertainty without silently completing',()=>{
  const adapter=bound();adapter.push(new TextEncoder().encode('{"id":'));
  const events=adapter.finish();assert.equal(events[0].code,'protocol_error');assert.equal(events.at(-1)?.uncertain,true);
});

test('only an interrupt for a known ended turn may retire an unanswered reply',()=>{
  const adapter=bound();adapter.expectResponse({id:1,method:'turn/interrupt',threadId:'thread',turnId:'turn'});
  assert.throws(()=>adapter.retireInterruptResponse(1),CodexProtocolError);
  adapter.push(bytes(notification('turn/completed',{threadId:'thread',turn:turn('turn','interrupted')})));
  adapter.retireInterruptResponse(1);assert.deepEqual(adapter.push(bytes({id:1,result:{}})),[]);assert.equal(adapter.finish().at(-1)?.uncertain,false);
  const pending=new CodexProtocolAdapter({version,context});pending.expectResponse({id:2,method:'thread/start'});
  assert.throws(()=>pending.retireInterruptResponse(2),CodexProtocolError);assert.equal(pending.finish().at(-1)?.uncertain,true);
});
