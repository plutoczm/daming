// Codex protocol test double: validates read-only CLI arguments; NEVER invokes a vendor.
const args = process.argv.slice(2);
if (!args.includes('exec') || !args.includes('--json') ||
    args[args.indexOf('-s') + 1] !== 'read-only') process.exit(21);
if (!args.at(-1).includes('src/sample.ts')) process.exit(22);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'offline-project-test' }));
console.log(JSON.stringify({
  type: 'item.completed', item: { type: 'agent_message',
    text: JSON.stringify({ path: 'src/sample.ts', find: 'answer = 1', replace: 'answer = 2' })
  }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
