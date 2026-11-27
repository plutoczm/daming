export class CodexProtocolError extends Error {}
/** Byte-based JSONL framing preserves UTF-8 split across stdout chunks. */
export class CodexJsonLines {
  private readonly limit:number;
  private pending:number[]=[];
  constructor(limit:number) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1024*1024)throw new CodexProtocolError('Invalid frame limit');
    this.limit=limit;
  }
  private parse():unknown|undefined {
    const bytes=new Uint8Array(this.pending);this.pending=[];
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();
    return text?JSON.parse(text):undefined;
  }
  push(chunk:Uint8Array):unknown[] {
    if(!(chunk instanceof Uint8Array))throw new CodexProtocolError('Expected stdout bytes');
    const frames:unknown[]=[];
    for(const byte of chunk) {
      if(byte===10){const frame=this.parse();if(frame!==undefined)frames.push(frame);}
      else {this.pending.push(byte);if(this.pending.length>this.limit)throw new CodexProtocolError('Codex frame exceeds limit');}
    }
    return frames;
  }
  finish():unknown[] {if(!this.pending.length)return [];const frame=this.parse();return frame===undefined?[]:[frame];}
}
