export class SseReader {
 private readonly decoder=new TextDecoder('utf-8',{fatal:true});private buffer='';private data:string[]=[];private event='';private size=0;private count=0;private total=0;
 private readonly accept:(value:unknown,event:string)=>void;
 constructor(accept:(value:unknown,event:string)=>void){this.accept=accept;}
 push(bytes:Uint8Array):void {
  this.total+=bytes.length;if(this.total>1024*1024)throw new Error('response_limit');
  this.buffer+=this.decoder.decode(bytes,{stream:true});this.lines();
  if(Buffer.byteLength(this.buffer)>65536)throw new Error('frame_limit');
 }
 private lines():void {
  let end:number;
  while((end=this.buffer.indexOf('\n'))>=0){
   let line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(line.endsWith('\r'))line=line.slice(0,-1);
   this.size+=Buffer.byteLength(line);if(this.size>65536)throw new Error('frame_limit');
   if(!line){if(this.data.length){if(++this.count>128)throw new Error('event_limit');this.accept(JSON.parse(this.data.join('\n')),this.event);}this.data=[];this.event='';this.size=0;}
   else if(line.startsWith(':'))continue;
   else {const i=line.indexOf(':');const key=i<0?line:line.slice(0,i);let value=i<0?'':line.slice(i+1);if(value.startsWith(' '))value=value.slice(1);if(key==='data')this.data.push(value);else if(key==='event')this.event=value;else if(!['id','retry'].includes(key))throw new Error('unsupported_sse_field');}
  }
 }
 finish():void {this.buffer+=this.decoder.decode();this.lines();if(this.buffer||this.data.length)throw new Error('truncated_frame');}
}
