import { integer,record } from './gateway-port.ts';
import type { Protocol,Usage } from './gateway-port.ts';
export function validateUsage(protocol:Protocol,input:unknown):Usage {
 const value=record(input);const allowed=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
 if(Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('unsupported_usage');
 for(const n of Object.values(value))integer(n);
 const u=value as Usage;
 if(protocol==='responses'&&u.cacheWriteTokens!==undefined)throw new Error('unsupported_cache_write');
 if(protocol==='responses'&&u.cacheReadTokens!==undefined&&(u.inputTokens===undefined||u.cacheReadTokens>u.inputTokens))throw new Error('invalid_cache_subset');
 return {...u};
}
export function reconcileUsage(protocol:Protocol,observed:unknown,evidence:unknown):'consistent'|'missing'|'conflict' {
 try {
  const a=observed===undefined?undefined:validateUsage(protocol,observed);
  const b=evidence===undefined?undefined:validateUsage(protocol,evidence);
  if(!a||!b)return 'missing';
  const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const;
  // Known contradictions take precedence over any missing field.
  if(keys.some(k=>a[k]!==undefined&&b[k]!==undefined&&a[k]!==b[k]))return 'conflict';
  if(a.inputTokens===undefined||a.outputTokens===undefined||b.inputTokens===undefined||b.outputTokens===undefined)return 'missing';
  if(keys.some(k=>(a[k]===undefined)!==(b[k]===undefined)))return 'missing';
  return 'consistent';
 }catch{return 'conflict';}
}
