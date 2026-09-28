// One pool per isolate: /v1/embeddings and /v1/rerank must share ONE
// scheduler (per-key cap 2 TOTAL, not 2 per route) and ONE cooldown map (a 429
// learned on either route benches the slot for both). Regression for the
// separate-instances finding at rerank.ts:17-18.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleEmbeddings } from '../src/embeddings.ts';
import { handleRerank } from '../src/rerank.ts';
import { POOL_PER_SLOT, sharedPool } from '../src/pool.ts';
import type { SlotHome } from '../src/placement.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Minimal DO namespace: hands out per-name stubs whose embed/forward can be
// driven by the test. Mirrors index.ts's env.VOYAGE_SLOT usage.
function fakeEnv(impl: { embed: (...a: never[]) => Promise<unknown>; forward: (...a: never[]) => Promise<unknown> }) {
  const stubs = new Map<string, unknown>();
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      if (!stubs.has(name)) stubs.set(name, { embed: impl.embed, forward: impl.forward });
      return stubs.get(name);
    },
  };
  return { VOYAGE_SLOT: ns } as unknown as Parameters<typeof handleRerank>[1];
}

const HOMES: SlotHome[] = [{ slot: 0, name: 'voyage-key-00', egress_ip: '203.0.113.1' }];

function post(path: string, body: unknown): Request {
  return new Request(`https://egress.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function freshPool(): void {
  // Each test starts from a clean shared pool. The bindings live in pool.ts,
  // so a route that kept its own instance stops responding to this reset.
  const p = sharedPool();
  p.cooldownUntil.clear();
  for (const k of ['waiters'] as const) (p.scheduler as unknown as Record<string, unknown>)[k] = [];
  (p.scheduler as unknown as { inflight: Map<number, number> }).inflight.clear();
}

test('(a) both routes use the same scheduler identity as pool.ts', async () => {
  freshPool();
  const p = sharedPool();
  let sawSched: unknown;

  const env = fakeEnv({
    embed: async () => ({ status: 200, vectors: [[0]], usage_tokens: 1 }),
    forward: async () => ({ status: 200, body: '{}' }),
  });
  // Embeddings must actually run through the shared scheduler: fill the only
  // slot to its cap with out-of-band acquires and require the real request to
  // block on them (that only happens if it uses pool.ts's instance).
  const held: number[] = [];
  for (let i = 0; i < POOL_PER_SLOT; i++) held.push(await p.scheduler.acquire([0], p.cooldownUntil, Date.now));
  const pending = handleEmbeddings(post('/v1/embeddings', { model: 'voyage/voyage-4-large', input: ['x'] }), env, HOMES, null);
  let settled = false;
  void pending.then(() => (settled = true));
  await sleep(50);
  assert.equal(settled, false, 'embeddings ignored the shared scheduler (own instance)');
  held.forEach((h) => p.scheduler.release(h));
  const res = await pending;
  assert.equal(res.status, 200, `embeddings status ${res.status}`);
  assert.equal(p.scheduler.load(0), 0, 'embeddings leaked a permit on the shared scheduler');

  // Rerank: same identity check.
  const held2: number[] = [];
  for (let i = 0; i < POOL_PER_SLOT; i++) held2.push(await p.scheduler.acquire([0], p.cooldownUntil, Date.now));
  const pending2 = handleRerank(post('/v1/rerank', { query: 'q', documents: ['d'], model: 'rerank-2.5' }), env, HOMES);
  let settled2 = false;
  void pending2.then(() => (settled2 = true));
  await sleep(50);
  assert.equal(settled2, false, 'rerank ignored the shared scheduler (own instance)');
  held2.forEach((h) => p.scheduler.release(h));
  const res2 = await pending2;
  assert.equal(res2.status, 200, `rerank status ${res2.status}`);
  assert.equal(p.scheduler.load(0), 0, 'rerank leaked a permit on the shared scheduler');
  sawSched = p.scheduler;
  assert.ok(sawSched, 'pool.ts exposed no scheduler');
});

test('(b) cap is 2 TOTAL per key across routes: emb + rerank block a third', async () => {
  freshPool();
  const p = sharedPool();
  assert.equal(POOL_PER_SLOT, 2, 'cap must stay 2');

  let inflight = 0;
  let peak = 0;
  const hold = async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await sleep(120);
    inflight -= 1;
  };
  const env = fakeEnv({
    embed: async () => {
      await hold();
      return { status: 200, vectors: [[0]], usage_tokens: 1 };
    },
    forward: async () => {
      await hold();
      return { status: 200, body: '{}' };
    },
  });

  const emb = handleEmbeddings(post('/v1/embeddings', { model: 'voyage/voyage-4-large', input: ['a'] }), env, HOMES, null);
  const rrk = handleRerank(post('/v1/rerank', { query: 'q', documents: ['d'], model: 'rerank-2.5' }), env, HOMES);
  await sleep(40);
  // Both routes hold one of the two shared permits, so the third acquire must
  // queue. With a per-route instance each route has its own cap of 2 and this
  // acquire returns immediately.
  let thirdDone = false;
  const third = p.scheduler.acquire([0], p.cooldownUntil, Date.now).then((s) => {
    thirdDone = true;
    return s;
  });
  await sleep(60);
  const embDone = await Promise.race([emb.then(() => true), sleep(1).then(() => false)]);
  assert.equal(thirdDone, false, 'third acquire did not queue (per-route instances?)');
  assert.equal(embDone, false, 'first call should still be in flight at this point');
  assert.equal(peak, 2, `combined concurrency ${peak}, expected 2`);

  p.scheduler.release(await third);
  const [r1, r2] = await Promise.all([emb, rrk]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(peak, 2, `combined concurrency ${peak}, expected 2 (never 4)`);
  assert.equal(p.scheduler.load(0), 0, 'permit leaked');
});

test('(c) a cooldown set on the rerank path benches the slot for embeddings', async () => {
  freshPool();
  const p = sharedPool();

  // Rerank answers 429 -> rerank.ts writes the cooldown into the shared map.
  const env429 = fakeEnv({
    embed: async () => ({ status: 200, vectors: [[0]], usage_tokens: 1 }),
    forward: async () => ({ status: 429, body: '{"error":"rate limited"}', retry_after_ms: 60_000 }),
  });
  const r = await handleRerank(post('/v1/rerank', { query: 'q', documents: ['d'], model: 'rerank-2.5' }), env429, HOMES);
  assert.equal(r.status, 429, `rerank status ${r.status}`);
  assert.ok((p.cooldownUntil.get(0) ?? 0) > Date.now(), 'rerank did not set the shared cooldown');

  // Embeddings on the same (only) slot must now report no_healthy_slot.
  const env = fakeEnv({
    embed: async () => ({ status: 200, vectors: [[0]], usage_tokens: 1 }),
    forward: async () => ({ status: 200, body: '{}' }),
  });
  const e = await handleEmbeddings(post('/v1/embeddings', { model: 'voyage/voyage-4-large', input: ['x'] }), env, HOMES, null);
  const body = (await e.json()) as { error?: string };
  assert.equal(e.status, 503, `embeddings status ${e.status} (body ${JSON.stringify(body)})`);
  assert.equal(body.error, 'no_healthy_slot', `embeddings body ${JSON.stringify(body)}`);

  // And the reverse direction: embeddings' 429 must bench the slot for rerank.
  p.cooldownUntil.clear();
  const env429e = fakeEnv({
    embed: async () => ({ status: 429, vectors: undefined, error: 'rate limited', retry_after_ms: 60_000 }),
    forward: async () => ({ status: 200, body: '{}' }),
  });
  const e2 = await handleEmbeddings(post('/v1/embeddings', { model: 'voyage/voyage-4-large', input: ['x'] }), env429e, HOMES, null);
  assert.equal(e2.status, 503, `embeddings 429 status ${e2.status}`);
  const r2 = await handleRerank(post('/v1/rerank', { query: 'q', documents: ['d'], model: 'rerank-2.5' }), env, HOMES);
  const rb = (await r2.json()) as { error?: string };
  assert.equal(r2.status, 503, `rerank status ${r2.status} (body ${JSON.stringify(rb)})`);
  assert.equal(rb.error, 'no_healthy_slot', `rerank body ${JSON.stringify(rb)}`);
});