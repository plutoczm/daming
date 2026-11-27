import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';
const get=()=>{assert.equal(typeof (api as Record<string,unknown>).ProtocolDecoder,'function');return (api as unknown as {ProtocolDecoder:new(p:string)=>{push(b:Uint8Array):void;finish():{status:string;text:string;tools:unknown[];usage?:unknown}}}).ProtocolDecoder;};
const enc=new TextEncoder();
function decode(p:string,events:unknown[],split=false){const D=get();const d=new D(p);const wire=enc.encode(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));if(split)for(const b of wire)d.push(Uint8Array.of(b));else d.push(wire);return d.finish();}
const response=[
 {type:'response.created',response:{id:'r'}},
 {type:'response.output_text.delta',response_id:'r',delta:'合成 ✓'},
 {type:'response.completed',response:{id:'r',status:'completed',usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:4}}}}
];
const messages=[
 {type:'message_start',message:{id:'m',usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:4}}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成 ✓'}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
 {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
 {type:'message_stop'}
];
test('both protocol lifecycles survive every UTF8 byte boundary',()=>{for(const [p,e] of [['responses',response],['messages',messages]] as const){const r=decode(p,[...e],true);assert.equal(r.status,'completed');assert.equal(r.text,'合成 ✓');assert.deepEqual(r.usage,{inputTokens:10,outputTokens:2,cacheReadTokens:4});}});
test('tool fragments are assembled only at a valid block completion',()=>{
 const r=decode('responses',[response[0],{type:'response.output_item.added',response_id:'r',output_index:0,item:{type:'function_call',id:'i',call_id:'call',name:'fixture_echo',arguments:''}},{type:'response.function_call_arguments.delta',response_id:'r',item_id:'i',delta:'{"value":'},{type:'response.function_call_arguments.delta',response_id:'r',item_id:'i',delta:'"synthetic"}'},{type:'response.output_item.done',response_id:'r',item:{id:'i',type:'function_call',call_id:'call',name:'fixture_echo',arguments:'{"value":"synthetic"}'}},response[2]],true);
 assert.equal(r.status,'completed');assert.deepEqual(r.tools,[{id:'call',name:'fixture_echo',arguments:{value:'synthetic'}}]);
 const a=decode('messages',[messages[0],{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call',name:'fixture_echo',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"value":"synthetic"}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},messages[6]]);
 assert.equal(a.status,'completed');assert.deepEqual(a.tools,[{id:'call',name:'fixture_echo',arguments:{value:'synthetic'}}]);
});
test('partial contradictory or unsupported streams never complete',()=>{
 for(const events of [response.slice(0,2),[...response,response[2]],[response[0],{type:'response.output_text.delta',response_id:'other',delta:'bad'},response[2]],[response[0],{type:'alien_event'},response[2]],[response[0],{type:'error',message:'private'},response[2]]])assert.notEqual(decode('responses',events).status,'completed');
 assert.notEqual(decode('messages',[messages[0],messages[1],messages[2],messages[4],messages[6]]).status,'completed');
});
test('framing rejects malformed bytes JSON oversized frames and incomplete trailing data',()=>{for(const bytes of [Uint8Array.of(255),enc.encode('data: {bad}\n\n'),enc.encode('data: '+ 'x'.repeat(65537)+'\n\n'),enc.encode('data: {}')]){const D=get();const d=new D('responses');d.push(bytes);assert.notEqual(d.finish().status,'completed');}});
test('SSE comments multiline data and event names are supported',()=>{const D=get();const d=new D('responses');d.push(enc.encode(': keepalive\n\nevent: response.created\ndata: {"type":"response.created",\ndata: "response":{"id":"r"}}\n\n'));d.push(enc.encode('data: '+JSON.stringify(response[2])+'\n\n'));assert.equal(d.finish().status,'completed');});
test('missing usage is distinct from a reported zero snapshot',()=>{const end={type:'response.completed',response:{id:'r',status:'completed'}};assert.equal(decode('responses',[response[0],end]).usage,undefined);assert.deepEqual(decode('responses',[response[0],{type:'response.completed',response:{id:'r',status:'completed',usage:{input_tokens:0,output_tokens:0}}}]).usage,{inputTokens:0,outputTokens:0});});

test('Messages usage cannot go backwards and open tool args cannot be accepted',()=>{
 const decreasing=[...messages.slice(0,5),{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:0}},messages[6]];
 assert.notEqual(decode('messages',decreasing).status,'completed');
 const unfinished=[response[0],{type:'response.output_item.added',item:{id:'i',type:'function_call',call_id:'call',name:'fixture_echo',arguments:''}},response[2]];
 assert.notEqual(decode('responses',unfinished).status,'completed');
});
test('event and response limits stop excess streams',()=>{
 assert.notEqual(decode('responses',[response[0],...Array.from({length:129},()=>({type:'response.output_text.delta',delta:'a'})),response[2]]).status,'completed');
});

test('Messages reject conflicting stop reasons and any post-stop content',()=>{
 const start=messages[0],stop={type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},end=messages[6];
 assert.notEqual(decode('messages',[start,stop,{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},end]).status,'completed');
 assert.notEqual(decode('messages',[start,stop,messages[1],messages[2],messages[3],end]).status,'completed');
 assert.equal(decode('messages',[start,stop,{type:'message_delta',delta:{},usage:{output_tokens:3}},end]).status,'completed');
});
test('distinct blocks cannot reuse a normalized tool call identity in either protocol',()=>{
 const a=(id:string)=>({type:'response.output_item.added',item:{type:'function_call',id,call_id:'same',name:'fixture_echo',arguments:''}});
 const d=(id:string)=>({type:'response.function_call_arguments.delta',item_id:id,delta:'{"value":"synthetic"}'});
 const e=(id:string)=>({type:'response.output_item.done',item:{type:'function_call',id,call_id:'same',name:'fixture_echo',arguments:'{"value":"synthetic"}'}});
 assert.notEqual(decode('responses',[response[0],a('one'),d('one'),e('one'),a('two'),d('two'),e('two'),response[2]]).status,'completed');
 const blocks=[0,1].flatMap(index=>[{type:'content_block_start',index,content_block:{type:'tool_use',id:'same',name:'fixture_echo',input:{}}},{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:'{"value":"synthetic"}'}},{type:'content_block_stop',index}]);
 assert.notEqual(decode('messages',[messages[0],...blocks,{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},messages[6]]).status,'completed');
});
