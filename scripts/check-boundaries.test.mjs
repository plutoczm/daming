import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBoundaries } from './check-boundaries.mjs';

function fixture(t, changes = {}, paths = {}) {
  const root = mkdtempSync(join(tmpdir(), 'daming boundary '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({type:'module'}),
    'tsconfig.json': JSON.stringify({compilerOptions:{target:'ES2024', module:'NodeNext',moduleResolution:'NodeNext',paths:{
      '@daming/*':['./packages/*/src/index.ts'], ...paths
    }}}),
  };
  for (const name of ['core','ports','contracts','source-protocol','session-contracts','store-sqlite','workers','model-gateway','worker-process','governance','planning','auditor','connectors-lulu','autoloop']) {
    files['packages/'+name+'/package.json'] = JSON.stringify({name:'@daming/'+name,type:'module',exports:{'.':'./src/index.ts'},dependencies:['governance','planning','auditor'].includes(name)?{'@daming/core':'workspace:*'}:name==='worker-process'?{'@daming/workers':'workspace:*'}:name==='store-sqlite'?{'@daming/core':'workspace:*','@daming/ports':'workspace:*','@daming/governance':'workspace:*'}:name==='ports'?{'@daming/core':'workspace:*'}:{}});
    files['packages/'+name+'/src/index.ts'] = 'export interface Marker { readonly id: string }';
  }
  for (const name of ['server','web','desktop']) {
    files['apps/'+name+'/package.json'] = JSON.stringify({name:'@daming/'+name,type:'module',dependencies:name==='web'?{'@daming/contracts':'workspace:*'}:{}});
    files['apps/'+name+'/src/index.ts'] = 'export {};';
  }
  for (const [name, content] of Object.entries({...files,...changes})) {
    const file=join(root,name); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,content);
  }
  return root;
}
function refuses(t, code, area='packages/core', extra={}, paths={}) {
  const root=fixture(t,{[area+'/src/index.ts']:code,...extra},paths);
  const result=checkBoundaries(root);
  assert.ok(result.failures.length, 'expected rejection: '+code);
  return result;
}
test('accepts self-contained packages and whole-statement port type imports', t => {
  const root=fixture(t,{
    'packages/ports/src/index.ts':"import type { Marker } from '@daming/core'; export type Port = Marker;",
    'apps/web/src/index.ts':"export type { Marker } from '@daming/contracts';",
    'apps/server/src/index.ts':"import { readFileSync } from 'node:fs'; export {};",
  });
  assert.deepEqual(checkBoundaries(root).failures,[]);
});
test('core refuses Node, Electron, React and provider dependencies, including type imports', t => {
  for (const specifier of ['node:fs','fs','electron','react','@deepseek-ai/sdk']) {
    refuses(t, "import type { X } from '"+specifier+"'; export {};");
  }
});
test('ports cannot make a runtime dependency on core', t => {
  refuses(t,"import { type Marker } from '@daming/core'; export {};",'packages/ports');
});
test('web cannot reach Host through a local re-export', t => {
  refuses(t,"export * from './helper.ts';",'apps/web',{
    'apps/web/src/helper.ts':"export * from '../../server/src/index.ts';"
  });
});
test('web rejects Node builtins, runtime and type-only imports', t => {
  for (const code of ["import 'node:crypto';", "import type { Stats } from 'node:fs';", "export * from 'fs';"]) refuses(t,code,'apps/web');
});
test('the Feishu SDK is accessible only to the Host long-connection adapter', t => {
  const sdk = '@larksuiteoapi/node-sdk';
  const adapter = 'apps/server/src/feishu-long-connection.ts';
  const hostImport = `import '${sdk}';`;
  const dependencies = { [sdk]: '1.76.0' };
  const root = fixture(t, {
    'apps/server/package.json': JSON.stringify({ name: '@daming/server', type: 'module', dependencies }),
    'apps/web/package.json': JSON.stringify({ name: '@daming/web', type: 'module', dependencies }),
    [`node_modules/${sdk}/package.json`]: JSON.stringify({ name: sdk, types: 'index.d.ts' }),
    [`node_modules/${sdk}/index.d.ts`]: 'export {};',
    [adapter]: hostImport,
    'apps/server/src/index.ts': hostImport,
    'apps/web/src/index.ts': hostImport,
  });
  const failures = checkBoundaries(root).failures;
  assert.equal(failures.length, 2);
  assert.ok(failures.every(failure => failure.includes('Dependency outside permitted source')));
  assert.ok(failures.some(failure => failure.startsWith('apps/server/src/index.ts:')));
  assert.ok(failures.some(failure => failure.startsWith('apps/web/src/index.ts:')));
});
test('aliases cannot disguise Host or provider code as public contracts', t => {
  refuses(t,"import '#hidden';",'apps/web',{
    'apps/server/src/private.ts':'export const secret = 1;'
  },{'#hidden':['./apps/server/src/private.ts']});
  refuses(t,"import type { Marker } from '@daming/contracts';",'apps/web',{
    'apps/server/src/private.ts':'export interface Marker {}'
  },{'@daming/contracts':['./apps/server/src/private.ts']});
});
test('cross-package relative paths and private subpaths are rejected', t => {
  refuses(t,"import type { Marker } from '../../core/src/index.ts';",'packages/ports');
  refuses(t,"import type { Marker } from '@daming/core/private';",'packages/ports',{
    'packages/core/src/private.ts':'export interface Marker {}'
  },{'@daming/core/private':['./packages/core/src/private.ts']});
});
test('computed imports and requires fail closed', t => {
  for (const code of ["const name='x'; import(name);", "const name='x'; require(name);", "import.meta.glob('./*.ts');"]) refuses(t,code);
});
test('literal dynamic imports and CommonJS forms are inspected', t => {
  for (const code of ["import('node:fs');", "require('fs');", "import fs = require('fs');"]) refuses(t,code);
});
test('worker URL entries and script dependencies cannot bypass ownership', t => {
  refuses(t,"new Worker(new URL('../../../scripts/hidden.ts', import.meta.url));",'apps/web',{
    'scripts/hidden.ts':"import 'node:fs';"
  });
});
test('unresolved source modules and missing entry points fail closed', t => {
  refuses(t,"export * from './missing.ts';");
  const root=fixture(t); rmSync(join(root,'packages/core/src/index.ts'));
  assert.ok(checkBoundaries(root).failures.length);
});
test('contracts cannot smuggle Host state or private data dependencies to web', t => {
  refuses(t,"export * from '../../../apps/server/src/index.ts';",'packages/contracts');
});
test('package source cannot depend on tests or external shared source', t => {
  refuses(t,"export * from '../tests/helper.ts';",'packages/core',{'packages/core/tests/helper.ts':'export const x=1;'});
});

test('Windows junctions cannot move a package source outside its owner', t => {
  const root=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'daming outside '));
  t.after(()=>rmSync(outside,{recursive:true,force:true}));
  const src=join(root,'packages/core/src');
  const external=join(outside,'src');
  renameSync(src,external);
  symlinkSync(external,src,process.platform==='win32'?'junction':'dir');
  assert.ok(checkBoundaries(root).failures.length,'external package source must be rejected');
});

test('owned declaration files may contain pure type contracts', t => {
  const root=fixture(t,{
    'packages/core/src/index.ts':"export type { Hidden } from './bridge.d.ts';",
    'packages/core/src/bridge.d.ts':'export interface Hidden { id: string }'
  });
  assert.deepEqual(checkBoundaries(root).failures,[]);
});
test('owned declaration import edges cannot smuggle Node types', t => {
  for (const suffix of ['d.ts','d.mts','d.cts']) {
    refuses(t,"export type { Hidden } from './bridge."+suffix+"';",'packages/core',{
      ['packages/core/src/bridge.'+suffix]:"export type Hidden = import('node:fs').Stats;"
    });
  }
});
test('owned declaration imports must resolve', t => {
  refuses(t,"export type { Hidden } from './bridge.d.ts';",'packages/core',{
    'packages/core/src/bridge.d.ts':"export type Hidden = import('./missing.ts').Hidden;"
  });
});
test('triple-slash path references cannot cross packages or hide missing files', t => {
  for (const target of ['../../../apps/server/src/private.d.ts','./missing.d.ts']) {
    refuses(t,'/// <reference path="'+target+'" />\nexport {};','packages/core',{
      'apps/server/src/private.d.ts':'export interface Private {}'
    });
  }
});
test('triple-slash external type references cannot bypass pure package imports', t => {
  refuses(t,'/// <reference types="node" />\nexport {};');
});

test('SQLite adapter can use Node and public core/ports contracts', t => {
  const root=fixture(t,{'packages/store-sqlite/src/index.ts':"import { DatabaseSync } from 'node:sqlite'; import type { Marker } from '@daming/core'; export type Adapter = Marker;"});
  assert.deepEqual(checkBoundaries(root).failures,[]);
});
test('SQLite implementation remains inaccessible to core and web', t => {
  refuses(t,"import type { Marker } from '@daming/store-sqlite';");
  refuses(t,"import type { Marker } from '@daming/store-sqlite';",'apps/web');
});

test('process I/O stays in the Node adapter while pure workers and web reject it', t => {
  const root=fixture(t,{'packages/worker-process/src/index.ts':"import { spawn } from 'node:child_process'; import type { Marker } from '@daming/workers'; export type Bound = Marker;"});
  assert.deepEqual(checkBoundaries(root).failures,[]);
  refuses(t,"import 'node:child_process';",'packages/workers');
  refuses(t,"import type { Marker } from '@daming/worker-process';",'apps/web');
  refuses(t,"import type { Marker } from '@daming/worker-process';",'packages/core');
});

test('governance is a Host boundary and cannot leak into worker or renderer code',t=>{
  const root=fixture(t,{'packages/governance/src/index.ts':"import { createHash } from 'node:crypto'; import type { Marker } from '@daming/core'; export type Policy = Marker;"});
  assert.deepEqual(checkBoundaries(root).failures,[]);
  for(const area of ['packages/core','packages/workers','packages/worker-process','apps/web'])refuses(t,"import type { Marker } from '@daming/governance';",area);
  refuses(t,"import type { Marker } from '@daming/store-sqlite';",'packages/governance');
});

test('model gateway permits its narrow HTTP adapter but cannot own tasks or processes',t=>{
 const root=fixture(t,{'packages/model-gateway/src/index.ts':"import 'node:http'; import type { Socket } from 'node:net'; import { randomUUID } from 'node:crypto'; export {};"});
 assert.deepEqual(checkBoundaries(root).failures,[]);
 for(const module of ['node:fs','node:child_process'])refuses(t,"import '"+module+"';",'packages/model-gateway');
 for(const source of ['@daming/governance','@daming/store-sqlite','@daming/core'])refuses(t,"import type { Marker } from '"+source+"';",'packages/model-gateway');
 refuses(t,"import type { Marker } from '@daming/model-gateway';",'packages/governance');
 for(const area of ['packages/workers','apps/web'])refuses(t,"import type { Marker } from '@daming/model-gateway';",area);
});

test('Lulu connector may use crypto but cannot import Host or task state',t=>{
 const root=fixture(t,{'packages/connectors-lulu/src/index.ts':"import { createHash } from 'node:crypto'; export {};"});
 assert.deepEqual(checkBoundaries(root).failures,[]);
 for(const module of ['node:fs','node:http','node:child_process'])refuses(t,"import '"+module+"';",'packages/connectors-lulu');
 for(const source of ['@daming/core','@daming/store-sqlite','@daming/governance','@daming/server'])refuses(t,"import type { Marker } from '"+source+"';",'packages/connectors-lulu');
});

test('embedded Go service rejects external modules and database ownership',t=>{
 for(const specifier of ['database/sql','github.com/yetone/magpie/internal/provider','github.com/example/private']){
  const root=fixture(t,{'services/model-gateway-go/go.mod':'module github.com/yetone/magpie\ngo 1.26.8\n','services/model-gateway-go/internal/engine/bad.go':'package engine\nimport "'+specifier+'"\n'});
  assert.ok(checkBoundaries(root).failures.length,'Go boundary did not reject '+specifier);
 }
});

test('desktop shell may use Node but cannot own Host, task or provider state', t=>{
  const root=fixture(t,{'apps/desktop/src/index.ts':"import { join } from 'node:path'; export const p = join('a','b');"});
  assert.deepEqual(checkBoundaries(root).failures,[]);
  for(const source of ['@daming/server','@daming/core','@daming/model-gateway','@daming/governance'])refuses(t,"import type { Marker } from '"+source+"';",'apps/desktop');
  for(const source of ['@daming/desktop'])refuses(t,"import type { Marker } from '"+source+"';",'packages/core');
});

test('planning and auditor remain pure and core cannot reverse import them', t=>{
 assert.deepEqual(checkBoundaries(fixture(t)).failures,[]);
 for(const name of ['planning','auditor']){
  const result=refuses(t,"import 'node:fs';",'packages/'+name);
  assert.ok(result.failures.some(f=>f.includes('Node dependency is forbidden')));
  const reverse=refuses(t,"export * from '@daming/"+name+"';");
  assert.ok(reverse.failures.some(f=>f.includes('Forbidden dependency')));
 }
});
