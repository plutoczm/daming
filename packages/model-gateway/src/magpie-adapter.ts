export interface GatewayObservation {
  readonly status:'disabled'|'available'|'unavailable'|'incompatible';
  readonly models:readonly string[];
  readonly verifiedProtocols:readonly string[];
  readonly version?:string;
  readonly reason?:string;
}
export interface MagpieOptions { enabled?:boolean;baseUrl?:string;timeoutMs?:number;fetch?:typeof fetch; }
export class MagpieAdapter {
  private readonly options:MagpieOptions;
  private readonly url:string;
  constructor(options:MagpieOptions={}) {
    const url=new URL(options.baseUrl??'http://127.0.0.1:3425');
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new Error('Magpie discovery requires an explicit loopback root URL');
    const timeout=options.timeoutMs??1500;
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error('Invalid timeout');
    this.options={...options,timeoutMs:timeout};this.url=url.origin;
  }
  async probe():Promise<GatewayObservation> {
    const empty={models:[],verifiedProtocols:[]};
    if(!this.options.enabled)return {status:'disabled',...empty};
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},this.options.timeoutMs);});
    try {return await Promise.race([this.discover(controller.signal),expired]);}
    catch{return {status:'unavailable',reason:'probe_failed_or_timed_out',...empty};}
    finally {if(timer)clearTimeout(timer);controller.abort();}
  }
  private async json(path:string,signal:AbortSignal):Promise<unknown> {
    const response=await (this.options.fetch??fetch)(this.url+path,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer magpie-daming','user-agent':'Daming/0.0.0'}});
    if(!response.ok||!response.body)throw new Error('HTTP discovery failed');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    const stop=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
    try {
      while(true) {
        const chunk=await reader.read();if(chunk.done)break;
        size+=chunk.value.byteLength;if(size>1024*1024)throw new Error('Discovery response too large');
        chunks.push(chunk.value);
      }
      if(signal.aborted)throw new Error('Aborted');
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally {signal.removeEventListener('abort',stop);await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  private async discover(signal:AbortSignal):Promise<GatewayObservation> {
    const hello=await this.json('/api/hello',signal) as {name?:unknown;version?:unknown}|null;
    if(!hello||hello.name!=='magpie'||typeof hello.version!=='string'||!hello.version.trim())return {status:'incompatible',reason:'wrong_identity',models:[],verifiedProtocols:[]};
    const catalog=await this.json('/v1/models',signal) as {data?:unknown}|null;
    if(!catalog||!Array.isArray(catalog.data)||catalog.data.some(item=>!item||typeof item.id!=='string'||!item.id.trim()))return {status:'incompatible',reason:'invalid_catalog',models:[],verifiedProtocols:[]};
    return {status:'available',version:hello.version,models:[...new Set(catalog.data.map(item=>item.id as string))],verifiedProtocols:[]};
  }
}
