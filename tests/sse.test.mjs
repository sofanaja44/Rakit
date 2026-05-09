import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseJsonStream } from '../dist/providers/sse.js';

function responseFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }));
}

test('parseSseJsonStream parses LF, CRLF, done, and final unterminated event', async () => {
  const response = responseFromChunks([
    'data: {"a":1}\r\n\r\n',
    'data: {"b":2}\n\n',
    'data: [DONE]\n\n',
    'data: {"c":3}',
  ]);

  const events = [];
  for await (const event of parseSseJsonStream(response)) {
    events.push(event);
  }

  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('parseSseJsonStream can ignore invalid json events', async () => {
  const response = responseFromChunks(['data: nope\n\n', 'data: {"ok":true}\n\n']);
  const events = [];

  for await (const event of parseSseJsonStream(response, { ignoreInvalidJson: true })) {
    events.push(event);
  }

  assert.deepEqual(events, [{ ok: true }]);
});
