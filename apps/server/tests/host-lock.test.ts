import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import * as host from '../src/index.ts';
test('Host writer lock identifies Windows trailing-dot aliases as one directory',async t=>{
 const root=mkdtempSync(join(tmpdir(),'daming host-lock '));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const acquire=(host as unknown as {acquireHostLock:(p:string)=>Promise<{close():Promise<void>}>}).acquireHostLock;assert.equal(typeof acquire,'function');
 const a=await acquire(root);try{await assert.rejects(acquire(root+'.'));}finally{await a.close();}
 const b=await acquire(root+'.');await b.close();
});
