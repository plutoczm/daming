import { parentPort,workerData } from 'node:worker_threads';
import { SqliteStore } from '../../../store-sqlite/src/index.ts';
import { CostLedger,GovernanceError } from '../../src/index.ts';
const store=new SqliteStore(workerData.file);
try {
  try {new CostLedger(store,()=>workerData.now).reserve(workerData.operation);parentPort.postMessage({reserved:true});}
  catch(error) {if(!(error instanceof GovernanceError))throw error;parentPort.postMessage({reserved:false,code:error.code});}
} finally {store.close();}
