// DSH Headless test double: validates read-only environment and approval policy, no vendor call.
const args = process.argv.slice(2);
if (process.env.DSH_PERMISSION_MODE !== 'read-only' ||
    args[args.indexOf('--approval-policy') + 1] !== 'never') process.exit(31);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
if (!prompt.includes('answer = 2') || !prompt.includes('answer = 1')) process.exit(32);
console.log(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 0, outputTokens: 0 } }));
console.log(JSON.stringify({
  type: 'final', text: JSON.stringify({ approved: true, reason: 'Verified one scoped replacement in the isolated project copy' })
}));
