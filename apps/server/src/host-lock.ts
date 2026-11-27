import {mkdirSync,realpathSync,openSync,writeFileSync,readFileSync,unlinkSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
/** Kernel-exclusive creation uses the real file even through directory aliases. Stale locks fail closed. */
export async function acquireHostLock(input:string):Promise<{base:string;close:()=>Promise<void>}>{
 let lexical=resolve(input);if(process.platform==='win32')lexical=lexical.split(String.fromCharCode(92)).map(p=>p.replace(/[. ]+$/,'')).join(String.fromCharCode(92));mkdirSync(lexical,{recursive:true});const base=realpathSync.native(lexical);
 const file=join(base,'.daming-host-owner.lock');let fd:number;
 try{fd=openSync(file,'wx',0o600);}catch{throw new Error('Daming Host already running or stale lock requires operator verification');}
 const nonce=randomUUID();writeFileSync(fd,JSON.stringify({nonce,pid:process.pid}));
 let closed=false;
 return {base,close:async()=>{if(closed)return;closed=true;try{const saved=JSON.parse(readFileSync(file,'utf8'));if(saved.nonce!==nonce)throw new Error('Host lock ownership changed');unlinkSync(file);}finally{closeSync(fd);}}};
}
