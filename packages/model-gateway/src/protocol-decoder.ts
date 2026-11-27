import {SseReader} from './sse.ts';
import {integer,record,string} from './gateway-port.ts';
import type {Protocol,ProtocolResult,ToolCall,Usage} from './gateway-port.ts';
import {validateUsage} from './usage-reconcile.ts';
interface Block {kind:'text'|'tool';id:string;name:string;args:string;closed:boolean;}
export class ProtocolDecoder {
 private readonly reader:SseReader;private started=false;private terminal=false;private finished=false;private id='';private text='';private fault?:string;private unsupported=false;private usage?:Usage;private stop?:string;
 private readonly callIds=new Set<string>();
 private callId(value:unknown):string{const id=string(value);if(this.callIds.has(id))throw new Error('duplicate_call_id');this.callIds.add(id);return id;}
 private readonly blocks=new Map<string,Block>();private readonly tools:ToolCall[]=[];
 private readonly protocol:Protocol;
 constructor(protocol:Protocol){this.protocol=protocol;if(!['responses','messages'].includes(protocol))throw new Error('unsupported_protocol');this.reader=new SseReader((v,e)=>this.event(v,e));}
 get failed():boolean{return this.fault!==undefined;}
 push(bytes:Uint8Array):void{if(this.finished)throw new Error('decoder_finished');if(!this.fault)try{this.reader.push(bytes);}catch{this.fault='invalid_or_unsupported_stream';}}
 private setUsage(value:unknown):void{
  const raw=record(value);const u:Usage={};
  for(const [source,target] of [['input_tokens','inputTokens'],['output_tokens','outputTokens'],['cache_read_input_tokens','cacheReadTokens'],['cache_creation_input_tokens','cacheWriteTokens']] as const)if(raw[source]!==undefined)u[target]=integer(raw[source]);
  if(raw.input_tokens_details!==undefined){const d=record(raw.input_tokens_details);if(d.cached_tokens!==undefined)u.cacheReadTokens=integer(d.cached_tokens);}
  for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const)if(this.usage?.[k]!==undefined&&u[k]!==undefined&&u[k]!<this.usage[k]!)throw new Error('usage_regressed');
  this.usage=validateUsage(this.protocol,{...this.usage,...u});
 }
 private closeBlock(key:string,final?:Record<string,unknown>):void{
  const b=this.blocks.get(key);if(!b||b.closed)throw new Error('invalid_block');
  if(b.kind==='tool'){
   if(final&&(final.arguments!==b.args||final.call_id!==b.id||final.name!==b.name||final.type!=='function_call'))throw new Error('tool_mismatch');
   const args=record(JSON.parse(b.args));this.tools.push({id:b.id,name:b.name,arguments:args});
  }
  b.closed=true;
 }
 private event(value:unknown,event:string):void{
  const e=record(value);const type=string(e.type);
  if(event&&event!==type)throw new Error('event_type_mismatch');
  if(type==='ping')return;
  if(this.terminal)throw new Error('event_after_terminal');
  if(type==='error'||type==='response.failed'||type==='response.incomplete')throw new Error('remote_error');
  if(e.response_id!==undefined&&e.response_id!==this.id)throw new Error('response_identity');
  if(e.message_id!==undefined&&e.message_id!==this.id)throw new Error('message_identity');
  if(this.protocol==='responses')this.responses(type,e);else this.messages(type,e);
  if(Buffer.byteLength(this.text)>1024*1024)throw new Error('text_limit');
 }
 private responses(type:string,e:Record<string,unknown>):void{
  if(type==='response.created'){
   if(this.started)throw new Error('duplicate_start');this.id=string(record(e.response).id);this.started=true;return;
  }
  if(!this.started)throw new Error('missing_start');
  if(type==='response.output_text.delta'){if(typeof e.delta!=='string')throw new Error('invalid_delta');this.text+=e.delta;return;}
  if(type==='response.output_item.added'){
   const item=record(e.item);const id=string(item.id);
   if(item.type!=='function_call'||item.arguments!==''||this.blocks.has(id))throw new Error('unsupported_item');
   this.blocks.set(id,{kind:'tool',id:this.callId(item.call_id),name:string(item.name),args:'',closed:false});return;
  }
  if(type==='response.function_call_arguments.delta'){
   const b=this.blocks.get(string(e.item_id));if(!b||b.closed||typeof e.delta!=='string')throw new Error('invalid_tool_delta');b.args+=e.delta;if(Buffer.byteLength(b.args)>16384)throw new Error('args_limit');return;
  }
  if(type==='response.output_item.done'){const item=record(e.item);this.closeBlock(string(item.id),item);return;}
  if(type==='response.completed'){
   const r=record(e.response);if(r.id!==this.id||r.status!=='completed'||[...this.blocks.values()].some(b=>!b.closed))throw new Error('invalid_terminal');
   if(r.usage!==undefined)this.setUsage(r.usage);this.terminal=true;return;
  }
  this.unsupported=true;throw new Error('unsupported_event');
 }
 private messages(type:string,e:Record<string,unknown>):void{
  if(this.stop&&type.startsWith('content_block_'))throw new Error('content_after_stop');
  if(type==='message_start'){
   if(this.started)throw new Error('duplicate_start');const m=record(e.message);this.id=string(m.id);this.started=true;if(m.usage!==undefined)this.setUsage(m.usage);return;
  }
  if(!this.started)throw new Error('missing_start');
  if(type==='content_block_start'){
   const key=String(integer(e.index));const b=record(e.content_block);if(this.blocks.has(key))throw new Error('duplicate_block');
   if(b.type==='text'&&b.text==='')this.blocks.set(key,{kind:'text',id:'',name:'',args:'',closed:false});
   else if(b.type==='tool_use'&&Object.keys(record(b.input)).length===0)this.blocks.set(key,{kind:'tool',id:this.callId(b.id),name:string(b.name),args:'',closed:false});
   else throw new Error('unsupported_block');return;
  }
  if(type==='content_block_delta'){
   const b=this.blocks.get(String(integer(e.index)));const d=record(e.delta);if(!b||b.closed)throw new Error('invalid_block');
   if(b.kind==='text'&&d.type==='text_delta'&&typeof d.text==='string')this.text+=d.text;
   else if(b.kind==='tool'&&d.type==='input_json_delta'&&typeof d.partial_json==='string'){b.args+=d.partial_json;if(Buffer.byteLength(b.args)>16384)throw new Error('args_limit');}
   else throw new Error('unsupported_delta');return;
  }
  if(type==='content_block_stop'){this.closeBlock(String(integer(e.index)));return;}
  if(type==='message_delta'){const d=record(e.delta);if(d.stop_reason!==undefined){if(!['end_turn','tool_use'].includes(d.stop_reason as string))throw new Error('unsupported_stop');if(this.stop!==undefined&&this.stop!==d.stop_reason)throw new Error('conflicting_stop');this.stop=d.stop_reason as string;}if(e.usage!==undefined)this.setUsage(e.usage);return;}
  if(type==='message_stop'){if(!this.stop||[...this.blocks.values()].some(b=>!b.closed))throw new Error('invalid_terminal');this.terminal=true;return;}
  this.unsupported=true;throw new Error('unsupported_event');
 }
 finish():ProtocolResult {
  if(!this.finished){this.finished=true;if(!this.fault)try{this.reader.finish();}catch{this.fault='truncated_stream';}}
  if(!this.terminal&&!this.fault)this.fault='missing_terminal';
  return {status:this.fault?(this.unsupported?'unsupported':'unknown'):'completed',text:this.text,tools:structuredClone(this.tools),...(this.usage?{usage:{...this.usage}}:{}),...(this.fault?{reason:this.fault}:{})};
 }
}
