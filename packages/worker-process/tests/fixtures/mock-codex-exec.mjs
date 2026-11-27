console.log(JSON.stringify({ type: 'thread.started', thread_id: 'mock-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'OK' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 1 } }));
