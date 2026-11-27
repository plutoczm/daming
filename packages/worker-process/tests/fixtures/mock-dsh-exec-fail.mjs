for await (const chunk of process.stdin) void chunk;
console.log(JSON.stringify({ type: 'error', message: 'mock provider failure' }));
process.exit(1);
