import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
let prompt = '';
for await (const data of process.stdin) prompt += data;
const details = {
  args: process.argv.slice(2), prompt,
  home: process.env.CODEX_HOME,
  personalConfigPresent: existsSync(join(process.env.CODEX_HOME, 'auth.json')),
  apiKey: process.env.OPENAI_API_KEY ?? null,
  relayTokenSet: typeof process.env.DAMING_CODEX_RELAY_TOKEN === 'string',
  inheritedEnv: process.env.DAMING_TEST_SECRET ?? null
};
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(details) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 1 } }));
