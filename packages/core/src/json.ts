import { DomainError } from './errors.ts';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]:JsonValue };
/** Stable JSON comparison for replay; deliberately no hashing or implicit coercion. */
export function canonicalJson(value:unknown):string {
  const active=new Set<object>();
  function normalize(input:unknown):JsonValue {
    if(input===null||typeof input==='string'||typeof input==='boolean') return input;
    if(typeof input==='number'&&Number.isFinite(input)) return input;
    if(typeof input!=='object'||input===null) throw new DomainError('Expected finite JSON values');
    if(active.has(input)) throw new DomainError('Cyclic JSON is not allowed');
    if(!Array.isArray(input)&&Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null) throw new DomainError('Expected a plain JSON object');
    if(Object.getOwnPropertySymbols(input).length) throw new DomainError('Symbol keys are not JSON');
    active.add(input);
    try {
      return Array.isArray(input) ? Array.from(input,normalize) : Object.fromEntries(Object.keys(input).sort().map(key=>[key,normalize((input as Record<string,unknown>)[key])]));
    } finally { active.delete(input); }
  }
  return JSON.stringify(normalize(value));
}
