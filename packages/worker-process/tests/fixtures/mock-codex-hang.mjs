import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(prompt, process.env.CODEX_HOME);
setInterval(() => {}, 1000);
