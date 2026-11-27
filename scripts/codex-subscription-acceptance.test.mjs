import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('failed personal login metadata read never acquires or strands the Host lock', t => {
  const root = mkdtempSync(join(tmpdir(),'daming acceptance metadata '));
  t.after(() => rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const local = join(root,'local');
  const cliDir = join(local,'OpenAI','Codex','bin','synthetic');
  mkdirSync(cliDir,{recursive:true}); writeFileSync(join(cliDir,'codex.exe'),'not executable; never invoked');
  const base = join(root,'data');
  const script = fileURLToPath(new URL('./codex-subscription-acceptance.mjs',import.meta.url));
  const bootstrap = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.statSync; fs.statSync=(path,...args)=>{if(String(path).includes('.codex')){const error=new Error('synthetic sharing violation');error.code='EACCES';throw error;}return original(path,...args);};
    syncBuiltinESMExports(); process.argv=['node',${JSON.stringify(script)},'--send','--approved-cny=5'];
    try{await import(${JSON.stringify(new URL('./codex-subscription-acceptance.mjs',import.meta.url).href)});}catch{process.exitCode=1;}`;
  const result = spawnSync(process.execPath,['--input-type=module','-e',bootstrap],{
    cwd:root,env:{...process.env,LOCALAPPDATA:local,USERPROFILE:root,DAMING_DATA_DIR:base},encoding:'utf8',windowsHide:true
  });
  assert.equal(result.status,1);
  assert.equal(existsSync(join(base,'.daming-host-owner.lock')),false);
  assert.equal(existsSync(join(base,'host','tasks.sqlite')),false);
});

test('post-run metadata failure cannot prevent database and Host lock cleanup or erase evidence', t => {
  const root = mkdtempSync(join(tmpdir(),'daming acceptance final metadata '));
  t.after(() => rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const local=join(root,'local'), base=join(root,'data'), cliDir=join(local,'OpenAI','Codex','bin','synthetic');
  mkdirSync(cliDir,{recursive:true}); writeFileSync(join(cliDir,'codex.exe'),'never invoked');
  mkdirSync(join(base,'host'),{recursive:true});
  writeFileSync(join(base,'host','magpie-profile.json'),'{invalid profile');
  mkdirSync(join(root,'.cache','verification'),{recursive:true});
  const script=fileURLToPath(new URL('./codex-subscription-acceptance.mjs',import.meta.url));
  const bootstrap=`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.statSync; let reads=0;fs.statSync=(path,...args)=>{if(String(path).includes('.codex')&&++reads>2){const e=new Error('synthetic final sharing violation');e.code='EACCES';throw e;}return original(path,...args);};
    syncBuiltinESMExports();process.argv=['node',${JSON.stringify(script)},'--send','--approved-cny=5'];
    try{await import(${JSON.stringify(new URL('./codex-subscription-acceptance.mjs',import.meta.url).href)});}catch{process.exitCode=1;}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',bootstrap],{cwd:root,
    env:{...process.env,LOCALAPPDATA:local,USERPROFILE:root,DAMING_DATA_DIR:base},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);
  assert.equal(existsSync(join(base,'.daming-host-owner.lock')),false);
  const proof=JSON.parse(readFileSync(join(root,'.cache','verification','codex-subscription-live-2026-11-16.json'),'utf8'));
  assert.equal(proof.personalConfigComparisonUnavailable,true);
  assert.equal(proof.personalAgentConfigurationModified,null);
});
