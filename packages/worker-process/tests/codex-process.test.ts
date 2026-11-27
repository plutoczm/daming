import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexFixtureProcess, CodexProcessError } from '../src/index.ts';
const context={taskId:'task',runId:'run',attemptId:'attempt'};
function fixture(t:{after(fn:()=>Promise<void>):void},scenario='normal',extra:Record<string,unknown>={}) {
  const cwd=mkdtempSync(join(tmpdir(),'daming process space '));
  const transport=new CodexFixtureProcess({context,version:'0.167.0-alpha.3.2',cwd,scenario,...extra} as never);
  t.after(async()=>{await transport.close();rmSync(cwd,{recursive:true,force:true});});
  return transport;
}
test('stdio handshake, thread binding and turn streaming preserve context',{timeout:10000},async t=>{
  const process=fixture(t);await process.start();
  assert.equal((await process.createThread()).threadId,'fixture-thread');
  const result=await process.startTurn('大铭🙂');
  assert.equal(result.mode,'fixture_process');assert.equal(result.status,'completed');assert.equal(result.output,'大铭🙂');
  assert.equal(process.events().some(e=>e.kind==='text_delta'&&e.attemptId==='attempt'),true);
  const closed=await process.close();assert.equal(closed.uncertain,false);assert.equal(process.diagnostics().running,false);
});
test('fixture resume validates identity instead of creating unknown sessions',{timeout:10000},async t=>{
  const process=fixture(t);await process.start();
  await assert.rejects(process.resumeThread('missing'),CodexProcessError);
  assert.equal((await process.resumeThread('fixture-thread')).threadId,'fixture-thread');
});
test('initialization/request timeout terminates and drains the child',{timeout:10000},async t=>{
  const process=fixture(t,'silent',{requestTimeoutMs:50,closeGraceMs:50});
  await assert.rejects(process.start(),CodexProcessError);
  const closed=await process.close();assert.equal(closed.uncertain,true);assert.equal(process.diagnostics().running,false);
});
test('turn timeout rejects and does not synthesize success',{timeout:10000},async t=>{
  const process=fixture(t,'hang-turn',{closeGraceMs:50});await process.start();await process.createThread();
  await assert.rejects(process.startTurn('synthetic',{timeoutMs:50}),CodexProcessError);
  const closed=await process.close();assert.equal(closed.uncertain,true);
  assert.equal(process.events().some(e=>e.kind==='turn_completed'&&e.status==='completed'),false);
});
test('cancel waits for interrupted terminal rather than treating ACK as completion',{timeout:10000},async t=>{
  const process=fixture(t,'hang-turn');await process.start();await process.createThread();
  const pending=process.startTurn('synthetic');process.cancel();
  const result=await pending;assert.equal(result.status,'interrupted');assert.equal(result.uncertain,true);
  assert.equal(process.events().some(e=>e.kind==='interrupt_ack'),true);
});
test('unacknowledged or ineffective cancellation has a finite grace period',{timeout:10000},async t=>{
  const process=fixture(t,'ignore-interrupt',{cancelGraceMs:60,closeGraceMs:50});await process.start();await process.createThread();
  const pending=process.startTurn('synthetic');process.cancel();
  await assert.rejects(pending,CodexProcessError);assert.equal((await process.close()).uncertain,true);
});
test('pre-aborted signals do not submit a turn',{timeout:10000},async t=>{
  const process=fixture(t);await process.start();await process.createThread();
  const controller=new AbortController();controller.abort();
  await assert.rejects(process.startTurn('never submitted',{signal:controller.signal}),CodexProcessError);
  assert.equal(process.events().some(e=>e.kind==='turn_bound'),false);
});
test('malformed/partial stdout and process failure retain uncertainty',{timeout:10000},async t=>{
  for(const scenario of ['malformed','partial-eof','exit-nonzero']) {
    const process=fixture(t,scenario,{closeGraceMs:50});await process.start();await process.createThread();
    await assert.rejects(process.startTurn('synthetic'),CodexProcessError);
    assert.equal((await process.close()).uncertain,true);
  }
});
test('approval requests are never answered automatically',{timeout:10000},async t=>{
  const process=fixture(t,'approval-request',{closeGraceMs:50});await process.start();await process.createThread();
  await assert.rejects(process.startTurn('synthetic'),CodexProcessError);
  await process.close();assert.equal(process.events().some(e=>e.kind==='request_blocked'),true);
  assert.equal(JSON.stringify(process.events()).includes('private fixture command'),false);
});
test('stderr is drained without retaining private text and is size bounded',{timeout:10000},async t=>{
  const process=fixture(t,'stderr-flood',{maxStderrBytes:1024,closeGraceMs:50});await process.start();await process.createThread();
  await assert.rejects(process.startTurn('synthetic'),CodexProcessError);await process.close();
  assert.ok(process.diagnostics().stderrBytes>1024);assert.equal(JSON.stringify(process.diagnostics()).includes('fixture-secret'),false);
});
test('child environment does not inherit arbitrary parent variables',{timeout:10000},async t=>{
  const previous=process.env.DAMING_TEST_SECRET;process.env.DAMING_TEST_SECRET='must-not-leak';
  try {
    const transport=fixture(t,'env-check');await transport.start();await transport.createThread();
    assert.equal((await transport.startTurn('synthetic')).output,'isolated_environment');
  } finally {if(previous===undefined)delete process.env.DAMING_TEST_SECRET;else process.env.DAMING_TEST_SECRET=previous;}
});
test('concurrent turns and operations after close are rejected',{timeout:10000},async t=>{
  const process=fixture(t,'hang-turn');await process.start();await process.createThread();
  const first=process.startTurn('one');await assert.rejects(process.startTurn('two'),CodexProcessError);
  process.cancel();await first;await process.close();
  await assert.rejects(process.createThread(),CodexProcessError);await assert.rejects(process.start(),CodexProcessError);
});
test('close is idempotent and escalates when fixture ignores EOF',{timeout:10000},async t=>{
  const process=fixture(t,'ignore-eof',{closeGraceMs:50});await process.start();
  const [a,b]=await Promise.all([process.close(),process.close()]);
  assert.deepEqual(a,b);assert.equal(a.forced,true);assert.equal(process.diagnostics().running,false);
});
test('configuration cannot select a real executable or unsupported fixture scenario',()=>{
  assert.throws(()=>new CodexFixtureProcess({context,version:'0.167.0-alpha.3.2',cwd:'.',scenario:'real-codex'} as never),CodexProcessError);
});

test('a late cancellation error cannot terminate the following turn',{timeout:10000},async t=>{
  const process=fixture(t,'late-interrupt-error');await process.start();await process.createThread();
  const first=process.startTurn('first');process.cancel();assert.equal((await first).status,'interrupted');
  const second=await process.startTurn('second');assert.equal(second.status,'completed');assert.equal(second.output,'second');
});

test('spawn failure after cwd removal still reaches the close barrier',{timeout:10000},async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'daming removed cwd '));
  const transport=new CodexFixtureProcess({context,version:'0.167.0-alpha.3.2',cwd,closeGraceMs:50});
  t.after(async()=>{await transport.close();rmSync(cwd,{recursive:true,force:true});});
  rmSync(cwd,{recursive:true,force:true});
  await assert.rejects(transport.start());await transport.close();assert.equal(transport.diagnostics().running,false);
});
test('throwing event observers cannot break process control or mutate retained events',{timeout:10000},async t=>{
  const transport=fixture(t);transport.onEvent(async event=>{
    (event as unknown as {taskId:string}).taskId='changed';throw new Error('private observer diagnostic');
  });
  await transport.start();await transport.createThread();assert.equal((await transport.startTurn('fixture')).status,'completed');
  await transport.close();assert.ok(transport.diagnostics().listenerErrors>0);
  assert.equal(transport.events().some(e=>e.taskId==='changed'),false);
});

test('closing during the awaited initialized write cannot resurrect ready state',{timeout:10000},async t=>{
  const transport=fixture(t);
  transport.onEvent(async event=>{if(event.kind==='initialized'){await Promise.resolve();void transport.close();}});
  await assert.rejects(transport.start(),CodexProcessError);
  const exit=await transport.close();assert.equal(exit.forced,false);assert.equal(exit.uncertain,false);
  await assert.rejects(transport.createThread(),CodexProcessError);assert.equal(transport.diagnostics().running,false);
});
test('a retired interrupt with no reply cannot time out a following turn',{timeout:10000},async t=>{
  const transport=fixture(t,'lost-interrupt-reply',{requestTimeoutMs:200});await transport.start();await transport.createThread();
  const first=transport.startTurn('first');transport.cancel();assert.equal((await first).status,'interrupted');
  const second=await transport.startTurn('second');assert.equal(second.status,'completed');assert.equal(second.output,'second');
  assert.equal((await transport.close()).uncertain,false);
});
test('thread binding reserves ownership before any response arrives',{timeout:10000},async t=>{
  const transport=fixture(t);await transport.start();
  const results=await Promise.allSettled([transport.createThread(),transport.createThread(),transport.resumeThread('fixture-thread')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
});
