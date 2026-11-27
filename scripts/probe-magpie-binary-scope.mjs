/**
 * Isolated disposable-profile proof of the DEPLOYED Magpie Windows binary's
 * task-scope API. This is NOT a subscription account proof. It uses no user's
 * actual Magpie, Codex, Claude, OAuth or provider configuration.
 * No paid model calls; reads /api/hello and /v1/magpie/daming-task-scope.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, win32 } from 'node:path';

const candidate = process.argv.find(arg => arg.startsWith('--binary='));
const binary = resolve(candidate
  ? candidate.slice('--binary='.length)
  : 'runtime/magpie/windows-x64/daming-magpie-codex-subscription-v2.exe');
const dir = mkdtempSync(join(tmpdir(),'daming-magpie-scope-'));
const logFile = candidate
  ? '.cache/verification/magpie-candidate-scope-2026-11-16.json'
  : '.cache/verification/magpie-binary-scope-2026-11-16.json';
let child;
const proof = {
  source: 'disposable_profile_deployed_binary_readonly_check',
  observedAt: new Date().toISOString(),
  binaryPresent: existsSync(binary),
  binaryVariant: candidate ? 'staged_candidate' : 'currently_deployed',
  binaryScopedProtocolVerified: false,
  realAccountOwnershipVerified: false,
  realSubscriptionInferencePerformed: false,
  localModelNetworkRequestSent: false,
  machineSpecificOAuthTokensUsed: false,
  paidDispatchPermitted: false,
  status: 'not_run'
};
async function freePort() {
  return await new Promise((res,rej)=>{
    const s=net.createServer();
    s.once('error',rej);
    s.listen(0,'127.0.0.1',()=>{
      const a=s.address();
      const port=typeof a==='object' && a ? a.port : 0;
      s.close(err=>err?rej(err):res(port));
    });
  });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function limitedJson(url, cookie) {
  const response=await fetch(url,{
    headers: cookie ? {Cookie:cookie,Accept:'application/json'} : {Accept:'application/json'},
    redirect:'error',signal:AbortSignal.timeout(1500)
  });
  if(!response.ok || Number(response.headers.get('content-length'))>4096)
    throw new Error('scope_http_' + response.status);
  const text=await response.text();
  if(text.length>4096)throw new Error('scope_json_oversize');
  return JSON.parse(text);
}
try {
  if(process.platform!=='win32' || !existsSync(binary))
    throw new Error('windows_binary_missing');
  const port=await freePort();
  let adminPort=await freePort();
  while(adminPort===port)adminPort=await freePort();
  const webKey=randomBytes(24).toString('base64url');
  for(const folder of ['config','cache','state','local','appdata','home','temp']) {
    mkdirSync(join(dir,folder),{recursive:true});
  }
  const user=join(dir,'home');
  const env={
    SystemRoot:process.env.SystemRoot,
    WINDIR:process.env.WINDIR,
    PATH:process.env.PATH,
    COMSPEC:process.env.ComSpec,
    TMP:join(dir,'temp'),
    TEMP:join(dir,'temp'),
    HOME:user,USERPROFILE:user,
    APPDATA:join(dir,'appdata'),
    LOCALAPPDATA:join(dir,'local'),
    XDG_CONFIG_HOME:join(dir,'config'),
    XDG_CACHE_HOME:join(dir,'cache'),
    XDG_STATE_HOME:join(dir,'state'),
    XDG_DATA_HOME:join(dir,'state','data'),
    XDG_RUNTIME_DIR:join(dir,'state','runtime'),
    HOMEDRIVE:win32.parse(user).root.slice(0,2),
    HOMEPATH:user.slice(2),
    MAGPIE_ADDR:'127.0.0.1:'+port,
    MAGPIE_WEB_KEY:webKey,
    DAMING_MAGPIE_INSTANCE:randomBytes(16).toString('hex'),
    DAMING_CODEX_READONLY_AUTH:'1'
  };
  child=spawn(binary,['serve','--web=127.0.0.1:'+adminPort],{
    cwd:dir,env,windowsHide:true,shell:false,stdio:'ignore'
  });
  child.on('error',()=>{});
  let hello=false;
  for(let i=0;i<55;i++){
    if(child.exitCode!==null)break;
    try{
      const h=await limitedJson('http://127.0.0.1:'+port+'/api/hello');
      if(h?.name==='magpie'){hello=true;break;}
    }catch{}
    await sleep(200);
  }
  if(!hello)throw new Error('disposable_magpie_hello_unavailable');
  const scoped=await limitedJson('http://127.0.0.1:'+port+'/v1/magpie/daming-task-scope',
    'magpie_web_'+adminPort+'='+webKey);
  proof.binaryScopedProtocolVerified =
    scoped?.schemaVersion===1 &&
    scoped?.fixedAccount===true &&
    scoped?.singleUpstream===true &&
    scoped?.revokedLocalKeyFailsClosed===true;
  proof.codexPersonalLoginReadOnly = scoped?.codexPersonalLoginReadOnly === true;
  proof.status=proof.binaryScopedProtocolVerified
    ? (candidate ? 'staged_binary_native_task_scope_passed' : 'current_binary_native_task_scope_passed')
    : (candidate ? 'staged_binary_native_task_scope_unverified' : 'current_binary_native_task_scope_unverified');
}catch(error){
  proof.status=error instanceof Error ? error.message.slice(0,90) : 'not_available';
}finally{
  if(child && child.exitCode===null){
    child.kill();
    await Promise.race([
      new Promise(resolve=>child.once('close',resolve)),sleep(3000)
    ]);
  }
  try{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:90});}catch{}
  writeFileSync(resolve(logFile),JSON.stringify(proof,null,2)+'\n');
  console.log('MAGPIE_BINARY_SCOPE_CHECK='+JSON.stringify({
    nativeTaskScope:proof.binaryScopedProtocolVerified,
    disposableProfile:true,subscriptionOwnerProven:false,
    file:logFile,status:proof.status
  }));
}

