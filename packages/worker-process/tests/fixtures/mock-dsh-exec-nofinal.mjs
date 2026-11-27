for await (const chunk of process.stdin) void chunk;
console.log(JSON.stringify({ type: 'session', sessionId: 'session-mock', cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'text', text: 'OK' }));
