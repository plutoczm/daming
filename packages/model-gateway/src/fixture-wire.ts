import type {FixtureRequest,Usage} from './gateway-port.ts';
export function wireRequest(r:FixtureRequest):unknown{
 const tools=r.template==='tool'?[r.protocol==='responses'?{type:'function',name:'fixture_echo',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}:{name:'fixture_echo',input_schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]:[];
 return r.protocol==='responses'?{model:r.model,input:'Synthetic input',stream:true,max_output_tokens:128,metadata:{fixture_request:JSON.stringify(r)},tools}:{model:r.model,messages:[{role:'user',content:'Synthetic input'}],stream:true,max_tokens:128,metadata:{user_id:JSON.stringify(r)},tools};
}
export function fixtureUsage(scenario:string):Usage {return scenario==='zero-usage'?{inputTokens:0,outputTokens:0}:{inputTokens:10,outputTokens:2,cacheReadTokens:4};}
export function wireEvents(r:FixtureRequest,scenario:string):unknown[]{
 const u=fixtureUsage(scenario);const observed=scenario==='usage-conflict'?{...u,outputTokens:99}:u;const missing=scenario==='missing-usage';
 if(r.protocol==='responses'){
  const events:unknown[]=[{type:'response.created',response:{id:r.requestId}}];
  if(r.template==='text')events.push({type:'response.output_text.delta',response_id:r.requestId,delta:'合成 ✓'});
  else events.push({type:'response.output_item.added',response_id:r.requestId,item:{type:'function_call',id:'item',call_id:'call',name:'fixture_echo',arguments:''}},{type:'response.function_call_arguments.delta',response_id:r.requestId,item_id:'item',delta:'{"value":'},{type:'response.function_call_arguments.delta',response_id:r.requestId,item_id:'item',delta:'"synthetic"}'},{type:'response.output_item.done',response_id:r.requestId,item:{type:'function_call',id:'item',call_id:'call',name:'fixture_echo',arguments:'{"value":"synthetic"}'}});
  events.push({type:'response.completed',response:{id:scenario==='wrong-identity'?'foreign':r.requestId,status:'completed',...(!missing?{usage:{input_tokens:observed.inputTokens,output_tokens:observed.outputTokens,...(observed.cacheReadTokens!==undefined?{input_tokens_details:{cached_tokens:observed.cacheReadTokens}}:{})}}:{})}});return events;
 }
 const usage=missing?{}:{usage:{input_tokens:observed.inputTokens,output_tokens:0,...(observed.cacheReadTokens!==undefined?{cache_read_input_tokens:observed.cacheReadTokens}:{})}};
 const events:unknown[]=[{type:'message_start',message:{id:r.requestId,...usage}}];
 if(r.template==='text')events.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成 ✓'}});
 else events.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call',name:'fixture_echo',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"value":'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'"synthetic"}'}});
 events.push({type:'content_block_stop',index:0},{type:'message_delta',message_id:scenario==='wrong-identity'?'foreign':r.requestId,delta:{stop_reason:r.template==='text'?'end_turn':'tool_use'},...(!missing?{usage:{output_tokens:observed.outputTokens}}:{})},{type:'message_stop'});return events;
}
