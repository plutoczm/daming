import { CodexFixtureProcess } from '../packages/worker-process/src/index.ts';
const transport=new CodexFixtureProcess({version:'0.167.0-alpha.3.2',context:{taskId:'fixture-task',runId:'fixture-run',attemptId:'fixture-attempt'},cwd:process.cwd()});
try {
  await transport.start();await transport.createThread();
  const turn=await transport.startTurn('Synthetic subprocess communication');
  const exit=await transport.close();
  console.log(JSON.stringify({mode:'fixture_process',turn,exit,eventCount:transport.events().length,modelRequests:0},null,2));
} finally {await transport.close();}
