import { MagpieAdapter } from '../packages/model-gateway/src/index.ts';
// Explicit read-only command: no daemon launch, settings read or model request.
const observation=await new MagpieAdapter({enabled:true,baseUrl:process.argv[2]??'http://127.0.0.1:3425'}).probe();
console.log(JSON.stringify({status:observation.status,version:observation.version,modelCount:observation.models.length,verifiedProtocols:observation.verifiedProtocols,reason:observation.reason},null,2));
