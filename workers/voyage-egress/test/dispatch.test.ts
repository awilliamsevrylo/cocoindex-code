// Unit tests for the /v1/embeddings dispatch core with fake slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, makeBatches, NoHealthySlot, type SlotCall } from '../src/dispatch.ts';

// Fake slot: vector = [slot, charCodeOf(first char)] so order + origin are visible.
const echo: SlotCall = async (slot, batch) => ({
  status: 200,
  vectors: batch.map((t) => [slot, t.charCodeAt(0)]),
  usage_tokens: batch.length,
});

test('vectors come back in input order across batches and slots', async () => {
  const input = Array.from({ length: 30 }, (_, i) => String.fromCharCode(65 + i) + 'x'.repeat(50_000));
  const r = await dispatch(input, [0, 1, 2], echo, new Map());
  assert.equal(r.vectors.length, 30);
  r.vectors.forEach((v, i) => assert.equal(v[1], 65 + i, `index ${i} out of order`));
  assert.ok(new Set(r.vectors.map((v) => v[0])).size > 1, 'work should spread over slots');
});

test('no batch exceeds the token budget; oversize input splits', () => {
  const input = Array.from({ length: 10 }, () => 'y'.repeat(100_000)); // ~33K tokens each
  const batches = makeBatches(input);
  assert.ok(batches.length >= 3, `expected split, got ${batches.length} batch(es)`);
  for (const b of batches) {
    const tokens = b.reduce((n, i) => n + Math.ceil(input[i].length / 3) + 1, 0);
    assert.ok(tokens <= 120_000 || b.length === 1, `batch over budget: ${tokens}`);
  }
});

test('input count cap splits at 1000', () => {
  const batches = makeBatches(Array.from({ length: 2500 }, () => 'a'));
  assert.deepEqual(batches.map((b) => b.length), [1000, 1000, 500]);
});

test('a 429 slot is cooled down and its batch re-routes', async () => {
  const cooldown = new Map<number, number>();
  const flaky: SlotCall = async (slot, batch) =>
    slot === 0 ? { status: 429, retry_after_ms: 60_000 } : echo(slot, batch);
  const r = await dispatch(['a', 'b', 'c'], [0, 1], flaky, cooldown, () => 1_000);
  assert.equal(r.vectors.length, 3);
  assert.ok(r.vectors.every((v) => v[0] === 1), 'all vectors must come from the healthy slot');
  assert.ok(r.rerouted >= 1);
  assert.equal(cooldown.get(0), 61_000);
});

test('all slots cooling down fails closed with no_healthy_slot', async () => {
  const always429: SlotCall = async () => ({ status: 429 });
  await assert.rejects(dispatch(['a'], [0, 1], always429, new Map(), () => 0), NoHealthySlot);
});

test('non-retryable 4xx surfaces instead of re-routing', async () => {
  const bad: SlotCall = async () => ({ status: 400, error: 'bad model' });
  await assert.rejects(dispatch(['a'], [0, 1], bad, new Map()), /voyage 400/);
});
