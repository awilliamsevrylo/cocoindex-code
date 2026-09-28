import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamEmbeddingsResponse, type EmbeddingsStreamPayload } from '../src/stream-json.ts';

function renderOld(payload: EmbeddingsStreamPayload): string {
  return JSON.stringify({
    object: 'list',
    data: payload.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: payload.model,
    usage: { prompt_tokens: payload.usage.prompt_tokens, total_tokens: payload.usage.total_tokens },
    voyage_egress: {
      calls: payload.voyage_egress.calls,
      rerouted: payload.voyage_egress.rerouted,
      slots: payload.voyage_egress.slots,
    },
  });
}

test('streamed body is byte-compatible and deep-equal to old json for 1-vector case', async () => {
  const payload: EmbeddingsStreamPayload = {
    vectors: [[0.12345, -0.6789, 0.0, 1.0]],
    model: 'voyage-4-large',
    usage: { prompt_tokens: 5, total_tokens: 5 },
    voyage_egress: { calls: 1, rerouted: 0, slots: [0] },
  };

  const oldString = renderOld(payload);
  const resp = streamEmbeddingsResponse(payload);
  assert.equal(resp.headers.get('content-type'), 'application/json');
  const streamedString = await resp.text();

  assert.equal(streamedString, oldString, 'streamed text should match old serialized string');
  assert.deepStrictEqual(JSON.parse(streamedString), JSON.parse(oldString));
});

test('streamed body is deep-equal to old json for 1,000-vector 1024-dim case', async () => {
  const numVectors = 1000;
  const dim = 1024;
  const vectors: number[][] = [];
  for (let i = 0; i < numVectors; i++) {
    // Generate deterministic 1024-dim float values
    const vec = new Array<number>(dim);
    for (let d = 0; d < dim; d++) {
      vec[d] = Math.round(((i * 31 + d * 17) % 1000) / 1000 * 10000) / 10000;
    }
    vectors.push(vec);
  }

  const payload: EmbeddingsStreamPayload = {
    vectors,
    model: 'voyage-3-large',
    usage: { prompt_tokens: 50000, total_tokens: 50000 },
    voyage_egress: { calls: 4, rerouted: 1, slots: [0, 1, 2, 0] },
  };

  const oldString = renderOld(payload);
  const resp = streamEmbeddingsResponse(payload);
  assert.equal(resp.headers.get('content-type'), 'application/json');
  const streamedString = await resp.text();

  const parsedOld = JSON.parse(oldString);
  const parsedStreamed = JSON.parse(streamedString);

  assert.equal(parsedStreamed.data.length, numVectors);
  assert.equal(parsedStreamed.data[0].embedding.length, dim);
  assert.equal(parsedStreamed.data[numVectors - 1].index, numVectors - 1);
  assert.deepStrictEqual(parsedStreamed, parsedOld);
  assert.equal(streamedString, oldString);
});

test('streamed body handles multiple small vectors and preserves index order', async () => {
  const payload: EmbeddingsStreamPayload = {
    vectors: [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
    model: 'voyage-4',
    usage: { prompt_tokens: 10, total_tokens: 10 },
    voyage_egress: { calls: 2, rerouted: 0, slots: [1, 2] },
  };

  const oldString = renderOld(payload);
  const resp = streamEmbeddingsResponse(payload);
  const streamedString = await resp.text();

  assert.deepStrictEqual(JSON.parse(streamedString), JSON.parse(oldString));
  assert.equal(streamedString, oldString);
});
