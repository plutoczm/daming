import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeTextFrame, parseFrames } from '../src/index.ts';

// Server (unmasked) text frame builder for tests.
function serverTextFrame(text: string): Buffer {
  const p = Buffer.from(text, 'utf8'); const len = p.length; let h: Buffer;
  if (len < 126) h = Buffer.from([0x81, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  return Buffer.concat([h, p]);
}

test('encodeTextFrame → parseFrames roundtrip (client masked frame)', () => {
  for (const s of ['OK', 'x'.repeat(200), 'y'.repeat(70000), '{"type":"response.completed"}']) {
    const { frames, rest } = parseFrames(encodeTextFrame(s));
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, 0x1);
    assert.equal(frames[0].payload.toString('utf8'), s);
  }
});

test('parseFrames handles server (unmasked) frames, multiple + partial rest', () => {
  const a = serverTextFrame('{"type":"response.output_text.delta","delta":"OK"}');
  const b = serverTextFrame('hello');
  const { frames, rest } = parseFrames(Buffer.concat([a, b, Buffer.from([0x81])]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString('utf8').includes('"OK"'), true);
  assert.equal(frames[1].payload.toString('utf8'), 'hello');
  assert.equal(rest.length, 1); // incomplete header left over
});

test('parseFrames: ping opcode surfaced', () => {
  const ping = Buffer.from([0x89, 0x02, 0x68, 0x69]); // opcode 0x9, len 2, "hi"
  const { frames } = parseFrames(ping);
  assert.equal(frames[0].opcode, 0x9);
  assert.equal(frames[0].payload.toString('utf8'), 'hi');
});
